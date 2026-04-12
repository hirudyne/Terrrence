import { api } from './api'
// Main editor pane - tabs for open entities, CodeMirror 6 + Yjs per entity.

import { getState, setState, subscribe } from './state'
import { getOrCreateEditor, destroyEditor, refreshEntityCache } from './editor'

export class EditorPane {
  private el: HTMLElement
  private openTabs: string[] = []     // entity slugs in tab order
  private tabNames: Map<string, string> = new Map()  // slug -> display_name
  private activeTab: string | null = null
  private editorArea: HTMLElement

  constructor(container: HTMLElement) {
    this.el = container
    this.el.className = 'editor-pane'

    const tabBar = document.createElement('div')
    tabBar.className = 'editor-tab-bar'
    tabBar.id = 'editor-tab-bar'
    this.el.appendChild(tabBar)

    this.editorArea = document.createElement('div')
    this.editorArea.className = 'editor-area'
    this.el.appendChild(this.editorArea)

    let _lastActive: string | null = null
    let _lastProject: string | null = null
    subscribe(state => {
      if (!state.projectSlug) {
        _lastActive = null
        _lastProject = null
        this._showNoProject()
        return
      }
      // Only act when activeEntitySlug or projectSlug actually changes
      if (state.activeEntitySlug !== _lastActive || state.projectSlug !== _lastProject) {
        _lastActive = state.activeEntitySlug
        _lastProject = state.projectSlug
        if (state.activeEntitySlug) this._openEntity(state.activeEntitySlug)
      }
    })

    this._showNoProject()
  }

  private _showNoProject() {
    this.editorArea.innerHTML = '<div class="editor-empty">Open or create a project to start editing.</div>'
  }

  private async _openEntity(slug: string) {
    const state = getState()
    if (!state.projectSlug) return

    const alreadyActive = this.activeTab === slug

    if (!this.openTabs.includes(slug)) {
      this.openTabs.push(slug)
    }
    this.activeTab = slug
    this._renderTabBar()

    // Only remount if switching to a different entity
    if (!alreadyActive) {
      await this._mountEditor(slug)
      refreshEntityCache(state.projectSlug)
    }
  }

  private _renderTabBar() {
    const bar = document.getElementById('editor-tab-bar')!
    bar.innerHTML = ''
    for (const slug of this.openTabs) {
      const tab = document.createElement('button')
      tab.className = 'editor-tab' + (slug === this.activeTab ? ' active' : '')
      tab.textContent = this.tabNames.get(slug) ?? slug
      tab.onclick = () => {
        this.activeTab = slug
        setState({ activeEntitySlug: slug })
        this._renderTabBar()
        this._mountEditor(slug)
      }

      const close = document.createElement('span')
      close.className = 'editor-tab-close'
      close.textContent = 'x'
      close.onclick = (e) => {
        e.stopPropagation()
        this._closeTab(slug)
      }
      tab.appendChild(close)
      bar.appendChild(tab)
    }
  }

  private _closeTab(slug: string) {
    destroyEditor(slug)
    this.openTabs = this.openTabs.filter(s => s !== slug)
    if (this.activeTab === slug) {
      this.activeTab = this.openTabs[this.openTabs.length - 1] ?? null
      if (this.activeTab) setState({ activeEntitySlug: this.activeTab })
    }
    this._renderTabBar()
    if (this.activeTab) {
      this._mountEditor(this.activeTab)
    } else {
      this.editorArea.innerHTML = '<div class="editor-empty">No open entities.</div>'
    }
  }

  private async _mountEditor(slug: string) {
    const state = getState()
    if (!state.projectSlug) return

    this.editorArea.innerHTML = ''
    const detail = await api.getEntity(state.projectSlug, slug)
    this.tabNames.set(slug, detail.display_name || slug)
    this._renderTabBar()

    const wrap = document.createElement('div')
    wrap.style.height = '100%'
    this.editorArea.appendChild(wrap)

    // Save logic is now handled inside editor.ts (per-space + 1s debounce).
    getOrCreateEditor(slug, detail.type ?? 'unknown', wrap, detail.body, (_content) => { /* handled in editor.ts */ })
  }
}
