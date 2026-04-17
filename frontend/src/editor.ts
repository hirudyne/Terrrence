import {
  EditorView, ViewUpdate, ViewPlugin, Decoration, DecorationSet,
  keymap, highlightActiveLine, lineNumbers,
} from '@codemirror/view'
import { EditorState, RangeSetBuilder, Transaction } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { autocompletion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import * as Y from 'yjs'
import { yCollab } from 'y-codemirror.next'
import { WebsocketProvider } from 'y-websocket'
import { api } from './api'
import { getState, setState } from './state'

// ---------------------------------------------------------------------------
// Token patterns - must match backend REF_PATTERNS
// @@display@@  ##display##  ~~display~~  ??slug??  !!trigger!!effect!!
// ---------------------------------------------------------------------------

const TOKEN_RE = /(@@[^@]+@@|##[^#]+##|~~[^~]+~~|!!(?:[^!]|![^!])*!!|\?\?[^?]+\?\?|\u201c\u201c[^\u201c\u201d]+\u201d\u201d)/g

// A token is "committed" when its closing delimiter has just been typed.
// Returns { displayName, type } or null.


// ---------------------------------------------------------------------------
// Token highlighting
// ---------------------------------------------------------------------------

const locationMark  = Decoration.mark({ class: 'cm-token-location' })
const characterMark = Decoration.mark({ class: 'cm-token-character' })
const itemMark      = Decoration.mark({ class: 'cm-token-item' })
const eventMark     = Decoration.mark({ class: 'cm-token-event' })
const chapterMark      = Decoration.mark({ class: 'cm-token-chapter' })
const conversationMark = Decoration.mark({ class: 'cm-token-conversation' })

function markForToken(raw: string): Decoration {
  if (raw.startsWith('@@')) return locationMark
  if (raw.startsWith('##')) return characterMark
  if (raw.startsWith('~~')) return itemMark
  if (raw.startsWith('??')) return chapterMark
  if (raw.startsWith('“')) return conversationMark
  return eventMark
}

// Callback set per-editor instance so the highlighter can trigger entity logic
let _onTokenComplete: ((match: string, type: string) => void) | null = null
// Pending token waiting for Tab/Enter confirmation
let _pendingToken: { inner: string; type: string } | null = null

const tokenHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) { this.decorations = this._build(view) }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this._build(update.view)
      }
      if (_onTokenComplete) {
        const cursor = update.state.selection.main.head
        const text = update.state.doc.toString()
        // Find the most recently completed token: its end must be <= cursor and within 2 chars
        TOKEN_RE.lastIndex = 0
        let best: { raw: string; tokenEnd: number } | null = null
        let m: RegExpExecArray | null
        while ((m = TOKEN_RE.exec(text)) !== null) {
          const tokenEnd = m.index + m[0].length
          if (tokenEnd <= cursor && cursor - tokenEnd <= 2) {
            if (!best || tokenEnd > best.tokenEnd) best = { raw: m[0], tokenEnd }
          }
        }
        if (best) {
          const raw = best.raw
          const type = raw.startsWith('@@') ? 'location'
            : raw.startsWith('##') ? 'character'
            : raw.startsWith('~~') ? 'item'
            : raw.startsWith('??') ? 'chapter'
            : raw.startsWith('\u201c') ? 'conversation'
            : 'event'
          const delimLen = 2
          const inner = raw.slice(delimLen, -delimLen).trim()
          if (!_pendingToken || _pendingToken.type !== type) {
            // Update cursor class on editor dom
            const dom = update.view.dom
            dom.classList.forEach(c => { if (c.startsWith('cm-pending-')) dom.classList.remove(c) })
            dom.classList.add(`cm-pending-${type}`)
          }
          _pendingToken = { inner, type }
        } else {
          if (_pendingToken) {
            const dom = update.view.dom
            dom.classList.forEach(c => { if (c.startsWith('cm-pending-')) dom.classList.remove(c) })
          }
          _pendingToken = null
        }
      }
    }
    _build(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>()
      for (const { from, to } of view.visibleRanges) {
        const text = view.state.doc.sliceString(from, to)
        let m: RegExpExecArray | null
        TOKEN_RE.lastIndex = 0
        while ((m = TOKEN_RE.exec(text)) !== null) {
          builder.add(from + m.index, from + m.index + m[0].length, markForToken(m[0]))
        }
      }
      return builder.finish()
    }
  },
  { decorations: v => v.decorations }
)

// ---------------------------------------------------------------------------
// Autocomplete - suggest existing entity display names after opening delimiter
// ---------------------------------------------------------------------------

let _entityCache: { slug: string; type: string; display_name: string }[] = []

export async function refreshEntityCache(projectSlug: string) {
  _entityCache = await api.listEntities(projectSlug)
}

function terrrenceComplete(context: CompletionContext): CompletionResult | null {
  // Match after opening delimiter: @@ ## ~~ ??
  const word = context.matchBefore(/(@@|##|~~|\?\?|\u201c\u201c)[^\u201c\u201d]*/) 
  if (!word || (word.from === word.to && !context.explicit)) return null

  const prefix = word.text.startsWith('\u201c\u201c') ? '\u201c\u201c' : word.text.startsWith('\u201c') ? '\u201c\u201c' : word.text.slice(0, 2)
  const typeMap: Record<string, string> = {
    '@@': 'location', '##': 'character', '~~': 'item', '??': 'chapter', '\u201c': 'conversation',
  }
  const closing: Record<string, string> = {
    '@@': '@@', '##': '##', '~~': '~~', '??': '??', '\u201c': '\u201d',
  }
  const targetType = typeMap[prefix]
  if (!targetType) return null

  const options = _entityCache
    .filter(e => e.type === targetType)
    .map(e => ({
      label: prefix + e.display_name + closing[prefix],
      detail: e.slug,
      type: 'variable' as const,
    }))
  return { from: word.from, options }
}

// ---------------------------------------------------------------------------
// Editor factory
// ---------------------------------------------------------------------------

interface EditorInstance {
  view: EditorView
  destroy: () => void
}

const _instances: Map<string, EditorInstance> = new Map()

export function getOrCreateEditor(
  entitySlug: string,
  entityType: string,
  container: HTMLElement,
  initialContent: string,
  onChange?: (content: string) => void
): EditorView {
  const existing = _instances.get(entitySlug)
  if (existing) {
    container.appendChild(existing.view.dom)
    // If the on-disk content differs from what the editor shows (e.g. after
    // an out-of-band save), update the doc without touching Yjs state.
    const currentDoc = existing.view.state.doc.toString()
    if (initialContent && currentDoc !== initialContent && existing.view.state.doc.length === 0) {
      existing.view.dispatch({
        changes: { from: 0, to: currentDoc.length, insert: initialContent }
      })
    }
    return existing.view
  }

  const appState = getState()
  const project  = appState.projectSlug!

  // Wire token-complete callback into the shared highlighter slot
  _onTokenComplete = (displayName: string, type: string) => {
    const nav = (window as any)._terrrenceNav
    const parentSlug = (type === 'event' || type === 'conversation') ? entitySlug : undefined
    if (type === 'event' && entityType !== 'chapter') return
    if (type === 'conversation' && entityType !== 'character') return
    console.debug('[terrrence] ensureEntity call', { project, displayName, type, parentSlug })
    api.ensureEntity(project, displayName, type, parentSlug)
      .then(entity => {
        console.debug('[terrrence] ensureEntity result', entity)
        if (entity.blocked || !entity.slug) return
        if (entity.created) {
          refreshEntityCache(project)
          if (nav) nav.addEntityLocal({
            slug: entity.slug,
            type: entity.type,
            display_name: entity.display_name,
            parent_slug: parentSlug ?? null,
          })
        }
        setState({ previewEntitySlug: entity.slug })
      })
      .catch((e: unknown) => { console.debug('[terrrence] ensureEntity error', e) })
  }

  const ydoc     = new Y.Doc()
  const ytext    = ydoc.getText('codemirror')
  const wsProto  = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsBase   = `${wsProto}//${location.host}/ws/yjs`
  const provider = new WebsocketProvider(wsBase, `${project}/${entitySlug}`, ydoc)

  // Seed ytext with disk content only after the Yjs sync handshake completes.
  // If the server already has content it will arrive via SYNC_STEP2 and overwrite;
  // if the server room is empty the provider fires 'synced' with ytext still empty,
  // at which point we insert from disk. This prevents double-content on reconnect.
  let seeded = false
  provider.once('synced', () => {
    if (!seeded && ytext.toString() === '' && initialContent) {
      seeded = true
      ydoc.transact(() => ytext.insert(0, initialContent), 'seed')
    }
  })

  // Fallback: if WS connection fails entirely, seed from disk immediately
  // so the editor is usable offline.
  setTimeout(() => {
    if (!seeded && ytext.toString() === '' && initialContent) {
      seeded = true
      ydoc.transact(() => ytext.insert(0, initialContent), 'seed')
    }
  }, 3000)

  const initialDoc = ''  // yCollab will populate from ytext once synced

  let lastSaved = initialContent
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let navReloadTimer: ReturnType<typeof setTimeout> | null = null

  async function _save(content: string) {
    if (content === lastSaved) return
    lastSaved = content
    try {
      setSaveStatus('saving')
      await api.updateEntity(project, entitySlug, { body: content })
      setSaveStatus('saved')
      if (navReloadTimer) clearTimeout(navReloadTimer)
      navReloadTimer = setTimeout(() => {
        const nav = (window as any)._terrrenceNav
        if (nav) nav.load(project)
        // Set preview to the token nearest the cursor
        const doc = view.state.doc.toString()
        const cursor = view.state.selection.main.head
        const tokenRe = /(@@([^@]+)@@|##([^#]+)##|~~([^~]+)~~|\?\?([^?]+)\?\?|\u201c\u201c([^\u201c\u201d]+)\u201d\u201d)/g
        const typeMap: Record<number, string> = { 2: 'location', 3: 'character', 4: 'item', 5: 'chapter', 6: 'conversation' }
        let best: { displayName: string; type: string; dist: number } | null = null
        let m: RegExpExecArray | null
        while ((m = tokenRe.exec(doc)) !== null) {
          const start = m.index
          const end = m.index + m[0].length
          const dist = cursor >= start && cursor <= end ? 0 : Math.min(Math.abs(cursor - start), Math.abs(cursor - end))
          if (best === null || dist < best.dist) {
            const grpIdx = [2,3,4,5,6].find(i => m![i] !== undefined)
            if (grpIdx !== undefined) {
              best = { displayName: m[grpIdx].trim(), type: typeMap[grpIdx], dist }
            }
          }
        }
        if (best && best.dist < 200) {
          const parentSlug = (best.type === 'event' || best.type === 'conversation') ? entitySlug : undefined
          api.ensureEntity(project, best.displayName, best.type, parentSlug)
            .then(entity => { if (!entity.blocked && entity.slug) setState({ previewEntitySlug: entity.slug }) })
            .catch(() => {})
        }
      }, 2000)
    } catch (_) {}
  }

  const extensions = [
    lineNumbers(),
    history(),
    keymap.of([
      {
        key: 'Tab',
        run: () => {
          if (_pendingToken && _onTokenComplete) {
            _onTokenComplete(_pendingToken.inner, _pendingToken.type)
            _pendingToken = null
            return true
          }
          return false
        }
      },
      {
        key: 'Enter',
        run: () => {
          if (_pendingToken && _onTokenComplete) {
            _onTokenComplete(_pendingToken.inner, _pendingToken.type)
            _pendingToken = null
            return true
          }
          return false
        }
      },
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    markdown(),
    highlightActiveLine(),
    EditorView.lineWrapping,
    tokenHighlighter,
    autocompletion({ override: [terrrenceComplete] }),
    yCollab(ytext, provider.awareness),
    EditorView.theme({
      '&':                   { height: '100%', fontSize: '14px' },
      '.cm-scroller':        { overflow: 'auto', fontFamily: 'monospace', wordBreak: 'break-word' },
      '.cm-token-location':  { color: '#7ec8e3', fontWeight: 'bold' },
      '.cm-token-character': { color: '#f4a261', fontWeight: 'bold' },
      '.cm-token-item':      { color: '#a8dadc', fontWeight: 'bold' },
      '.cm-token-event':     { color: '#e9c46a', fontWeight: 'bold' },
      '.cm-token-chapter':      { color: '#c77dff', fontWeight: 'bold' },
      '.cm-token-conversation': { color: '#ff9eb5', fontWeight: 'bold' },
      '&.cm-pending-location .cm-cursor': { borderLeftColor: '#7ec8e3 !important', borderLeftWidth: '3px !important' },
      '&.cm-pending-character .cm-cursor': { borderLeftColor: '#f4a261 !important', borderLeftWidth: '3px !important' },
      '&.cm-pending-item .cm-cursor': { borderLeftColor: '#a8dadc !important', borderLeftWidth: '3px !important' },
      '&.cm-pending-event .cm-cursor': { borderLeftColor: '#e9c46a !important', borderLeftWidth: '3px !important' },
      '&.cm-pending-chapter .cm-cursor': { borderLeftColor: '#c77dff !important', borderLeftWidth: '3px !important' },
      '&.cm-pending-conversation .cm-cursor': { borderLeftColor: '#ff9eb5 !important', borderLeftWidth: '3px !important' },
    }),
    EditorView.updateListener.of((update: ViewUpdate) => {
      if (!update.docChanged) return
      const content = update.state.doc.toString()
      onChange?.(content)

      // Per-space save
      let spaceInserted = false
      update.transactions.forEach((tr: Transaction) => {
        tr.changes.iterChanges((_fA, _tA, _fB, _tB, ins) => {
          if (/\s/.test(ins.toString())) spaceInserted = true
        })
      })
      if (spaceInserted) {
        _save(content)
      } else {
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => _save(content), 1000)
      }


    }),
  ]

  const view = new EditorView({
    state: EditorState.create({ doc: initialDoc, extensions }),
    parent: container,
  })

  const instance: EditorInstance = {
    view,
    destroy: () => {
      provider.destroy()
      ydoc.destroy()
      view.destroy()
      _instances.delete(entitySlug)
    },
  }
  _instances.set(entitySlug, instance)
  return view
}

export function setSaveStatus(status: 'saving' | 'saved') {
  const nav = (window as any)._terrrenceNav
  if (nav && nav.setSaveStatus) nav.setSaveStatus(status)
}

export function destroyEditor(entitySlug: string) {
  _instances.get(entitySlug)?.destroy()
}

export function editorIsCached(entitySlug: string): boolean {
  return _instances.has(entitySlug)
}
