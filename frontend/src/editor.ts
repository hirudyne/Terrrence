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
function _detectCompletedToken(
  docAfter: string,
  insertedAt: number,
  insertedText: string,
): { displayName: string; type: string } | null {
  // Only trigger on the closing character of a delimiter
  const closingChars = new Set(['@', '#', '~', '?', '\u201d'])
  if (!insertedText.split('').some(c => closingChars.has(c) || /\s/.test(c))) return null

  const before = docAfter.slice(Math.max(0, insertedAt - 120), insertedAt + insertedText.length)

  // @@display@@
  const locMatch = before.match(/@@([^@]+)@@$/)
  if (locMatch) return { displayName: locMatch[1].trim(), type: 'location' }

  // ##display##
  const charMatch = before.match(/##([^#]+)##$/)
  if (charMatch) return { displayName: charMatch[1].trim(), type: 'character' }

  // ~~display~~
  const itemMatch = before.match(/~~([^~]+)~~$/)
  if (itemMatch) return { displayName: itemMatch[1].trim(), type: 'item' }

  // ??display name??
  const chapMatch = before.match(/\?\?([^?]+)\?\?$/)
  if (chapMatch) return { displayName: chapMatch[1].trim(), type: 'chapter' }

  // “conversation”
  const convMatch = before.match(/\u201c\u201c([^\u201c\u201d]+)\u201d\u201d$/)
  if (convMatch) return { displayName: convMatch[1].trim(), type: 'conversation' }

  return null
}


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

const tokenHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) { this.decorations = this._build(view) }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged)
        this.decorations = this._build(update.view)
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
      await api.updateEntity(project, entitySlug, { body: content })
      if (navReloadTimer) clearTimeout(navReloadTimer)
      navReloadTimer = setTimeout(() => {
        const nav = (window as any)._terrrenceNav
        if (nav) nav.load(project)
      }, 2000)
    } catch (_) {}
  }

  const extensions = [
    lineNumbers(),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
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

      // Auto-stub: detect completed tokens
      update.transactions.forEach((tr: Transaction) => {
        if (!tr.docChanged) return
        tr.changes.iterChanges((_fA, _tA, fromB, _tB, inserted) => {
          const insertedText = inserted.toString()
          const docAfter = update.state.doc.toString()
          const result = _detectCompletedToken(docAfter, fromB, insertedText)
          if (!result) return
          const { displayName, type } = result
          const nav = (window as any)._terrrenceNav
          // Events only auto-create when typed inside a chapter document
          const parentSlug = (type === 'event' || type === 'conversation') ? entitySlug : undefined
          if (type === 'event' && entityType !== 'chapter') return
          if (type === 'conversation' && entityType !== 'character') return
          api.ensureEntity(project, displayName, type, parentSlug)
            .then(entity => {
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
            .catch(() => {})
        })
      })
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

export function destroyEditor(entitySlug: string) {
  _instances.get(entitySlug)?.destroy()
}

export function editorIsCached(entitySlug: string): boolean {
  return _instances.has(entitySlug)
}
