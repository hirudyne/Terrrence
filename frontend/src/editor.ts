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
// Token patterns (must match backend REF_PATTERNS)
// ---------------------------------------------------------------------------

// A "complete" token: ends with its closing delimiter or is a bare @/# slug
// followed by a word boundary (space, punctuation, end-of-line).
const TYPE_FOR_PREFIX: Record<string, string> = {
  '@': 'location',
  '#': 'character',
  '~': 'item',
  '?': 'chapter',
}

// Detect a just-completed token in new text inserted at a position.
// Returns {slug, type} or null.
function _detectCompletedToken(
  _docBefore: string,
  docAfter: string,
  insertedAt: number,
  insertedText: string,
): { slug: string; type: string } | null {
  // Only trigger on whitespace or punctuation insertion
  if (!/[\s.,;:!?)]/.test(insertedText)) return null

  // Check the character just before the insertion point for closing delimiters
  // or scan backwards for an opening prefix
  const before = docAfter.slice(Math.max(0, insertedAt - 80), insertedAt)

  // Try ~slug~ and ??slug??
  const closedMatch = before.match(/~([a-zA-Z0-9_-]+)~$|\?\?([a-zA-Z0-9_-]+)\?\?$/)
  if (closedMatch) {
    const slug = closedMatch[1] ?? closedMatch[2]
    const type = closedMatch[1] ? 'item' : 'chapter'
    return { slug, type }
  }

  // Try @slug or #slug just before the whitespace/punctuation
  const openMatch = before.match(/[@#]([a-zA-Z0-9_-]+)$/)
  if (openMatch) {
    const prefix = before[before.length - openMatch[0].length]
    return { slug: openMatch[1], type: TYPE_FOR_PREFIX[prefix] ?? 'location' }
  }

  return null
}

// ---------------------------------------------------------------------------
// Token highlighting
// ---------------------------------------------------------------------------

const TOKEN_RE = /(@[a-zA-Z0-9_-]+|#[a-zA-Z0-9_-]+|~[a-zA-Z0-9_-]+~|!!(?:[^!]|![^!])*!!|\?\?[a-zA-Z0-9_-]+\?\?)/g

const locationMark  = Decoration.mark({ class: 'cm-token-location' })
const characterMark = Decoration.mark({ class: 'cm-token-character' })
const itemMark      = Decoration.mark({ class: 'cm-token-item' })
const eventMark     = Decoration.mark({ class: 'cm-token-event' })
const chapterMark   = Decoration.mark({ class: 'cm-token-chapter' })

function markForToken(raw: string) {
  if (raw.startsWith('@'))  return locationMark
  if (raw.startsWith('#'))  return characterMark
  if (raw.startsWith('~'))  return itemMark
  if (raw.startsWith('?'))  return chapterMark
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
          const start = from + m.index
          const end   = start + m[0].length
          builder.add(start, end, markForToken(m[0]))
        }
      }
      return builder.finish()
    }
  },
  { decorations: v => v.decorations }
)

// ---------------------------------------------------------------------------
// Autocomplete
// ---------------------------------------------------------------------------

let _entityCache: { slug: string; type: string; display_name: string }[] = []

export async function refreshEntityCache(projectSlug: string) {
  _entityCache = await api.listEntities(projectSlug)
}

function terrrenceComplete(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/[@#~?][a-zA-Z0-9_-]*|\?\?[a-zA-Z0-9_-]*/)
  if (!word || (word.from === word.to && !context.explicit)) return null
  const prefix = word.text[0]
  const typeMap: Record<string, string> = { '@': 'location', '#': 'character', '~': 'item', '?': 'chapter' }
  const targetType = typeMap[prefix]
  const options = _entityCache
    .filter(e => !targetType || e.type === targetType)
    .map(e => ({
      label: prefix + e.slug + (prefix === '~' ? '~' : prefix === '?' ? '??' : ''),
      detail: e.display_name,
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
  container: HTMLElement,
  initialContent: string,
  onChange?: (content: string) => void
): EditorView {
  const existing = _instances.get(entitySlug)
  if (existing) {
    container.appendChild(existing.view.dom)
    return existing.view
  }

  const appState = getState()
  const project  = appState.projectSlug!

  const ydoc    = new Y.Doc()
  const ytext   = ydoc.getText('codemirror')
  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsBase  = `${wsProto}//${location.host}/ws/yjs`
  const provider = new WebsocketProvider(wsBase, `${project}/${entitySlug}`, ydoc)

  if (ytext.toString() === '' && initialContent) {
    ydoc.transact(() => ytext.insert(0, initialContent))
  }

  // Per-space save: track last saved content to avoid redundant PATCHes
  let lastSaved = initialContent
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  async function _save(content: string) {
    if (content === lastSaved) return
    lastSaved = content
    try {
      await api.updateEntity(project, entitySlug, { body: content })
    } catch (_) { /* non-fatal */ }
  }

  const extensions = [
    lineNumbers(),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    markdown(),
    highlightActiveLine(),
    tokenHighlighter,
    autocompletion({ override: [terrrenceComplete] }),
    yCollab(ytext, provider.awareness),
    EditorView.theme({
      '&':                   { height: '100%', fontSize: '14px' },
      '.cm-scroller':        { overflow: 'auto', fontFamily: 'monospace' },
      '.cm-token-location':  { color: '#7ec8e3', fontWeight: 'bold' },
      '.cm-token-character': { color: '#f4a261', fontWeight: 'bold' },
      '.cm-token-item':      { color: '#a8dadc', fontWeight: 'bold' },
      '.cm-token-event':     { color: '#e9c46a', fontWeight: 'bold' },
      '.cm-token-chapter':   { color: '#c77dff', fontWeight: 'bold' },
    }),
    EditorView.updateListener.of((update: ViewUpdate) => {
      if (!update.docChanged) return
      const content = update.state.doc.toString()
      onChange?.(content)

      // Per-space save: save immediately on whitespace insertion
      let spaceInserted = false
      update.transactions.forEach((tr: Transaction) => {
        tr.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
          if (/\s/.test(inserted.toString())) spaceInserted = true
        })
      })
      if (spaceInserted) {
        _save(content)
      } else {
        // 1s debounce fallback
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => _save(content), 1000)
      }

      // Auto-stub: detect completed tokens and ensure entities exist
      update.transactions.forEach((tr: Transaction) => {
        if (!tr.docChanged) return
        tr.changes.iterChanges((_fromA, _toA, fromB, _toB, inserted) => {
          const insertedText = inserted.toString()
          const docAfter  = update.state.doc.toString()
          const result = _detectCompletedToken('', docAfter, fromB, insertedText)
          if (!result) return
          const { slug, type } = result
          api.ensureEntity(project, slug, type).then(entity => {
            if (entity.created) {
              // new stub - refresh cache and show in preview
              refreshEntityCache(project)
            }
            // always show the referenced entity in preview
            setState({ previewEntitySlug: entity.slug })
          }).catch(() => { /* non-fatal */ })
        })
      })
    }),
  ]

  const view = new EditorView({
    state: EditorState.create({ doc: ytext.toString(), extensions }),
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
