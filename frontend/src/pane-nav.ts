import { api, Entity } from './api'
import { getState, setState, subscribe } from './state'
import { showLogin } from './login'

type ViewMode = 'tree' | 'tabs'

const ALL_TYPES = ['game', 'chapter', 'location', 'character', 'item', 'event', 'conversation'] as const
const TYPE_PREFIX: Record<string, string> = {
  game:         'G',
  chapter:      '??',
  location:     '@@',
  character:    '##',
  item:         '~~',
  event:        '!!',
  conversation: '“”',
}
const CREATABLE_TYPES = ['chapter', 'location', 'character', 'item', 'event', 'conversation'] as const

// SVG icons
const EYE_ICON = `<svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`
const TRASH_ICON = `<svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>`

export class NavPane {
  private el: HTMLElement
  private mode: ViewMode = 'tree'
  private entities: Entity[] = []
  private selectedType: string = 'location'
  private _version: string = ''

  constructor(container: HTMLElement) {
    this.el = container
    this.el.className = 'nav-pane'
    let _lastProject: string | null = null
    let _lastActive: string | null = null
    subscribe(state => {
      if (state.projectSlug && state.projectSlug !== _lastProject) {
        _lastProject = state.projectSlug
        this.load(state.projectSlug)
        return
      }
      // Update active highlight without full re-render
      if (state.activeEntitySlug !== _lastActive) {
        _lastActive = state.activeEntitySlug
        this._updateActiveHighlight(state.activeEntitySlug)
      }
    })
    api.version().then(v => { this._version = v.version; this._renderVersionLabel() }).catch(() => {})
    this._render()

    // Auto-open project selector on first load if no project is active
    if (!getState().projectSlug) {
      // Small delay lets Golden Layout finish mounting before modal appears
      setTimeout(() => this._showProjectModal(), 150)
    }
  }

  private _updateActiveHighlight(activeSlug: string | null) {
    // Update active class on nav items without rebuilding DOM
    this.el.querySelectorAll('.nav-entity-item, .nav-chapter-group .nav-entity-item').forEach(el => {
      const name = el.querySelector('.nav-entity-name') as HTMLElement | null
      if (!name) return
      const slug = name.title
      if (activeSlug && slug === activeSlug) {
        el.classList.add('active')
      } else {
        el.classList.remove('active')
      }
    })
  }

  async load(projectSlug: string) {
    this.entities = await api.listEntities(projectSlug)
    this._render()
  }

  addEntityLocal(entity: { slug: string; type: string; display_name: string; parent_slug: string | null }) {
    if (!this.entities.find(e => e.slug === entity.slug)) {
      this.entities = [...this.entities, entity]
      this._render()
    }
  }

  private _render() {
    const state = getState()
    this.el.innerHTML = ''

    // -- header --
    const header = document.createElement('div')
    header.className = 'nav-header'

    const title = document.createElement('span')
    title.className = 'nav-project-name'
    title.textContent = state.projectName ?? 'Terrrence'
    header.appendChild(title)

    const modeToggle = document.createElement('button')
    modeToggle.className = 'nav-mode-toggle'
    modeToggle.textContent = this.mode === 'tree' ? 'Tabs' : 'Tree'
    modeToggle.onclick = () => { this.mode = this.mode === 'tree' ? 'tabs' : 'tree'; this._render() }
    header.appendChild(modeToggle)

    const projBtn = document.createElement('button')
    projBtn.className = 'nav-mode-toggle'
    projBtn.textContent = state.projectSlug ? '...' : 'Projects'
    projBtn.title = state.projectSlug ? 'Switch project' : 'Open / create project'
    projBtn.onclick = () => this._showProjectModal()
    header.appendChild(projBtn)

    const logoutBtn = document.createElement('button')
    logoutBtn.className = 'nav-mode-toggle nav-logout'
    logoutBtn.textContent = 'out'
    logoutBtn.title = 'Log out'
    logoutBtn.onclick = async () => {
      await api.logout().catch(() => {})
      setState({ label: null, projectSlug: null, projectName: null, activeEntitySlug: null, previewEntitySlug: null })
      document.getElementById('app')!.innerHTML = ''
      const loginEl = showLogin(() => { loginEl.remove(); window.location.reload() })
      document.getElementById('app')!.appendChild(loginEl)
    }
    header.appendChild(logoutBtn)
    this.el.appendChild(header)

    if (!state.projectSlug) {
      this.el.appendChild(this._projectSelector())
      if (this._version) this._renderVersionLabel()
      return
    }

    const addBtn = document.createElement('button')
    addBtn.className = 'nav-add-btn'
    addBtn.textContent = '+ New entity'
    addBtn.onclick = () => this._showCreateModal()
    this.el.appendChild(addBtn)

    if (this.mode === 'tree') {
      this.el.appendChild(this._treeView())
    } else {
      this.el.appendChild(this._tabView())
    }

    if (this._version) this._renderVersionLabel()
  }

  private _renderVersionLabel() {
    const existing = this.el.querySelector('.nav-version')
    if (existing) { existing.textContent = `v${this._version}`; return }
    const label = document.createElement('div')
    label.className = 'nav-version'
    label.textContent = `v${this._version}`
    this.el.appendChild(label)
  }

  // ---- project selector (no project open) ----

  private _projectSelector(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'project-selector'
    wrap.innerHTML = '<p>No project open.</p>'
    const btn = document.createElement('button')
    btn.textContent = 'Open / create project'
    btn.onclick = () => this._showProjectModal()
    wrap.appendChild(btn)
    return wrap
  }

  // ---- tree view ----

  private _treeView(): HTMLElement {
    const ul = document.createElement('ul')
    ul.className = 'nav-tree'

    // Game entity at top
    const gameEntity = this.entities.find(e => e.type === 'game')
    if (gameEntity) {
      const chapters = this.entities.filter(e => e.type === 'chapter')
      ul.appendChild(this._gameGroup(gameEntity, chapters))
    }

    // Locations, items (flat groups)
    for (const type of (['location', 'item'] as const)) {
      const group = this.entities.filter(e => e.type === type)
      const li = document.createElement('li')
      li.className = 'nav-group'
      const label = document.createElement('span')
      label.className = 'nav-group-label'
      label.textContent = `${TYPE_PREFIX[type]} ${type}s (${group.length})`
      li.appendChild(label)
      const children = document.createElement('ul')
      for (const entity of group) children.appendChild(this._entityItem(entity))
      li.appendChild(children)
      ul.appendChild(li)
    }

    // Characters with nested conversations
    const characters = this.entities.filter(e => e.type === 'character')
    const charLi = document.createElement('li')
    charLi.className = 'nav-group'
    const charLabel = document.createElement('span')
    charLabel.className = 'nav-group-label'
    charLabel.textContent = `## characters (${characters.length})`
    charLi.appendChild(charLabel)
    const charList = document.createElement('ul')
    for (const char of characters) {
      const convs = this.entities.filter(e => e.type === 'conversation' && e.parent_slug === char.slug)
      charList.appendChild(this._characterGroup(char, convs))
    }
    charLi.appendChild(charList)
    ul.appendChild(charLi)
    return ul
  }

  private _gameGroup(game: Entity, chapters: Entity[]): HTMLElement {
    const li = document.createElement('li')
    li.className = 'nav-group'

    // Game header row - clicking opens the game entity itself in editor
    const row = document.createElement('div')
    row.className = 'nav-game-row'

    const label = document.createElement('span')
    label.className = 'nav-group-label nav-group-label--game nav-entity-name'
    label.textContent = `G ${game.display_name}`
    label.title = 'Open game document in editor'
    label.onclick = () => setState({ activeEntitySlug: game.slug })
    row.appendChild(label)

    const actions = document.createElement('span')
    actions.className = 'nav-entity-actions'
    const eyeBtn = this._iconBtn(EYE_ICON, 'Open in preview', () => setState({ previewEntitySlug: game.slug }))
    actions.appendChild(eyeBtn)
    row.appendChild(actions)
    li.appendChild(row)

    // Chapters as children, each with their events nested under them
    const chapList = document.createElement('ul')
    chapList.className = 'nav-chapter-list'
    for (const chapter of chapters) {
      const events = this.entities.filter(e => e.type === 'event' && e.parent_slug === chapter.slug)
      chapList.appendChild(this._chapterGroup(chapter, events))
    }
    li.appendChild(chapList)
    return li
  }

  private _characterGroup(character: Entity, conversations: Entity[]): HTMLElement {
    const li = document.createElement('li')
    li.className = 'nav-chapter-group'

    const row = document.createElement('div')
    row.className = 'nav-entity-item'
    const state = getState()
    if (character.slug === state.activeEntitySlug) row.classList.add('active')

    const name = document.createElement('span')
    name.className = 'nav-entity-name'
    name.textContent = character.display_name
    name.title = character.slug
    name.onclick = () => setState({ activeEntitySlug: character.slug })
    row.appendChild(name)

    const actions = document.createElement('span')
    actions.className = 'nav-entity-actions'
    actions.appendChild(this._iconBtn(EYE_ICON, 'Open in preview', () => setState({ previewEntitySlug: character.slug })))
    actions.appendChild(this._iconBtn(TRASH_ICON, 'Delete', () => this._confirmDelete(character), true))
    row.appendChild(actions)
    li.appendChild(row)

    if (conversations.length > 0) {
      const convList = document.createElement('ul')
      convList.className = 'nav-event-list'
      for (const conv of conversations) convList.appendChild(this._entityItem(conv))
      li.appendChild(convList)
    }
    return li
  }

  private _chapterGroup(chapter: Entity, events: Entity[]): HTMLElement {
    const li = document.createElement('li')
    li.className = 'nav-chapter-group'

    const row = document.createElement('div')
    row.className = 'nav-entity-item'
    const state = getState()
    if (chapter.slug === state.activeEntitySlug) row.classList.add('active')

    const name = document.createElement('span')
    name.className = 'nav-entity-name'
    name.textContent = chapter.display_name
    name.title = chapter.slug
    name.onclick = () => setState({ activeEntitySlug: chapter.slug })
    row.appendChild(name)

    const actions = document.createElement('span')
    actions.className = 'nav-entity-actions'
    actions.appendChild(this._iconBtn(EYE_ICON, 'Open in preview', () => setState({ previewEntitySlug: chapter.slug })))
    actions.appendChild(this._iconBtn(TRASH_ICON, 'Delete', () => this._confirmDelete(chapter), true))
    row.appendChild(actions)
    li.appendChild(row)

    if (events.length > 0) {
      const evList = document.createElement('ul')
      evList.className = 'nav-event-list'
      for (const ev of events) evList.appendChild(this._entityItem(ev))
      li.appendChild(evList)
    }
    return li
  }

  // ---- tab view ----

  private _tabView(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'nav-tabs-wrap'

    const tabs = document.createElement('div')
    tabs.className = 'nav-type-tabs'
    for (const type of ALL_TYPES) {
      const btn = document.createElement('button')
      btn.textContent = TYPE_PREFIX[type]
      btn.title = type
      btn.className = 'nav-type-tab' + (type === this.selectedType ? ' active' : '')
      btn.onclick = () => { this.selectedType = type; this._render() }
      tabs.appendChild(btn)
    }
    wrap.appendChild(tabs)

    const list = document.createElement('ul')
    list.className = 'nav-entity-list'
    for (const entity of this.entities.filter(e => e.type === this.selectedType)) {
      list.appendChild(this._entityItem(entity))
    }
    wrap.appendChild(list)
    return wrap
  }

  // ---- entity item (generic) ----

  private _entityItem(entity: Entity): HTMLElement {
    const li = document.createElement('li')
    li.className = 'nav-entity-item'
    const state = getState()
    if (entity.slug === state.activeEntitySlug) li.classList.add('active')

    const nameSpan = document.createElement('span')
    nameSpan.className = 'nav-entity-name'
    nameSpan.textContent = entity.display_name
    nameSpan.title = entity.slug
    nameSpan.onclick = () => setState({ activeEntitySlug: entity.slug })
    li.appendChild(nameSpan)

    const actions = document.createElement('span')
    actions.className = 'nav-entity-actions'
    actions.appendChild(this._iconBtn(EYE_ICON, 'Open in preview', (e) => { e.stopPropagation(); setState({ previewEntitySlug: entity.slug }) }))
    if (entity.type !== 'game') {
      actions.appendChild(this._iconBtn(TRASH_ICON, 'Delete', (e) => { e.stopPropagation(); this._confirmDelete(entity) }, true))
    }
    li.appendChild(actions)
    return li
  }

  private _iconBtn(svgContent: string, title: string, handler: (e: MouseEvent) => void, danger = false): HTMLElement {
    const btn = document.createElement('button')
    btn.className = 'nav-action-btn' + (danger ? ' nav-action-btn--danger' : '')
    btn.title = title
    btn.innerHTML = svgContent
    btn.onclick = handler
    return btn
  }

  // ---- modals ----

  private _showProjectModal() {
    const modal = this._modal('Projects', (form, close, err) => {
      const listLabel = document.createElement('div')
      listLabel.className = 'modal-field-label'
      listLabel.textContent = 'Your projects'
      form.appendChild(listLabel)

      const listWrap = document.createElement('div')
      listWrap.className = 'modal-project-list'
      listWrap.textContent = 'Loading...'
      form.appendChild(listWrap)

      api.listProjects().then(projects => {
        listWrap.innerHTML = ''
        if (projects.length === 0) {
          listWrap.innerHTML = '<span class="modal-hint">No projects yet.</span>'
        } else {
          for (const p of projects) {
            const btn = document.createElement('button')
            btn.className = 'modal-project-item'
            btn.innerHTML = `<span class="mpi-name">${p.display_name}</span><span class="mpi-slug">${p.slug}</span>`
            btn.onclick = () => { setState({ projectSlug: p.slug, projectName: p.display_name }); close() }
            listWrap.appendChild(btn)
          }
        }
      }).catch(() => { listWrap.textContent = 'Failed to load.' })

      const div = document.createElement('div')
      div.className = 'modal-divider'
      div.textContent = 'or create new'
      form.appendChild(div)

      const slugInput = this._field(form, 'Slug', 'text', 'my_game')
      const nameInput = this._field(form, 'Display name', 'text', 'My Game')
      this._submitBtn(form, 'Create project', async () => {
        const slug = slugInput.value.trim()
        const name = nameInput.value.trim()
        if (!slug || !name) { err('Both fields required.'); return }
        try {
          const p = await api.createProject(slug, name)
          setState({ projectSlug: p.slug, projectName: p.display_name })
          close()
        } catch (e: any) { err(e.message) }
      })
    })
    document.body.appendChild(modal)
  }

  private _showCreateModal() {
    const state = getState()
    if (!state.projectSlug) return
    const hasGame = this.entities.some(e => e.type === 'game')
    const chapters = this.entities.filter(e => e.type === 'chapter')
    const characters = this.entities.filter(e => e.type === 'character')

    const modal = this._modal('New entity', (form, close, err) => {
      // Type dropdown
      const typeLabel = document.createElement('label')
      typeLabel.className = 'modal-field-label'
      typeLabel.textContent = 'Type'
      form.appendChild(typeLabel)

      const typeSelect = document.createElement('select')
      typeSelect.className = 'modal-select'

      const availableTypes = [...CREATABLE_TYPES, ...(!hasGame ? ['game' as const] : [])]
      for (const t of availableTypes) {
        const opt = document.createElement('option')
        opt.value = t
        opt.textContent = `${TYPE_PREFIX[t]}  ${t}`
        typeSelect.appendChild(opt)
      }
      form.appendChild(typeSelect)

      // Chapter selector - shown when type = event
      const chapterRow = document.createElement('div')
      chapterRow.style.display = 'none'
      const chapterLabel = document.createElement('label')
      chapterLabel.className = 'modal-field-label'
      chapterLabel.textContent = 'Parent chapter'
      chapterRow.appendChild(chapterLabel)
      const chapterSelect = document.createElement('select')
      chapterSelect.className = 'modal-select'
      if (chapters.length === 0) {
        const opt = document.createElement('option')
        opt.textContent = 'No chapters yet - create a chapter first'
        opt.disabled = true
        chapterSelect.appendChild(opt)
      } else {
        for (const ch of chapters) {
          const opt = document.createElement('option')
          opt.value = ch.slug
          opt.textContent = ch.display_name
          if (ch.slug === state.activeEntitySlug) opt.selected = true
          chapterSelect.appendChild(opt)
        }
      }
      chapterRow.appendChild(chapterSelect)
      form.appendChild(chapterRow)

      // Character selector - shown when type = conversation
      const charRow = document.createElement('div')
      charRow.style.display = 'none'
      const charRowLabel = document.createElement('label')
      charRowLabel.className = 'modal-field-label'
      charRowLabel.textContent = 'Parent character'
      charRow.appendChild(charRowLabel)
      const charSelect = document.createElement('select')
      charSelect.className = 'modal-select'
      if (characters.length === 0) {
        const opt = document.createElement('option')
        opt.textContent = 'No characters yet - create a character first'
        opt.disabled = true
        charSelect.appendChild(opt)
      } else {
        for (const ch of characters) {
          const opt = document.createElement('option')
          opt.value = ch.slug
          opt.textContent = ch.display_name
          if (ch.slug === state.activeEntitySlug) opt.selected = true
          charSelect.appendChild(opt)
        }
      }
      charRow.appendChild(charSelect)
      form.appendChild(charRow)

      const showParentRow = (type: string) => {
        chapterRow.style.display = type === 'event' ? 'flex' : 'none'
        chapterRow.style.flexDirection = 'column'
        chapterRow.style.gap = '4px'
        charRow.style.display = type === 'conversation' ? 'flex' : 'none'
        charRow.style.flexDirection = 'column'
        charRow.style.gap = '4px'
      }

      typeSelect.onchange = () => showParentRow(typeSelect.value)

      const slugInput  = this._field(form, 'Slug', 'text', 'e.g. C1 or old_barn')
      const nameInput  = this._field(form, 'Display name', 'text', 'e.g. Chapter 1 - Bundle Beginnings')

      this._submitBtn(form, 'Create', async () => {
        const type = typeSelect.value
        const slug = slugInput.value.trim()
        const name = nameInput.value.trim()
        if (!slug || !name) { err('Slug and display name required.'); return }
        if (type === 'event' && chapters.length === 0) { err('Create a chapter first.'); return }
        if (type === 'conversation' && characters.length === 0) { err('Create a character first.'); return }
        const parentSlug = type === 'event' ? chapterSelect.value
          : type === 'conversation' ? charSelect.value
          : undefined
        try {
          const entity = await api.createEntity(state.projectSlug!, { slug, display_name: name, type, parent_slug: parentSlug })
          this.addEntityLocal({
            slug: entity.slug,
            type: entity.type,
            display_name: entity.display_name,
            parent_slug: parentSlug ?? null,
          })
          setState({ activeEntitySlug: slug })
          close()
          this.load(state.projectSlug!).catch(() => {})
        } catch (e: any) { err(e.message) }
      })
    })
    document.body.appendChild(modal)
  }

  private async _confirmDelete(entity: Entity) {
    const state = getState()
    if (!state.projectSlug) return
    if (!confirm(`Delete "${entity.display_name}"? This cannot be undone.`)) return
    try {
      await api.deleteEntity(state.projectSlug, entity.slug)
      this.entities = this.entities.filter(e => e.slug !== entity.slug)
      this._render()
      if (state.activeEntitySlug === entity.slug) setState({ activeEntitySlug: null })
      if (state.previewEntitySlug === entity.slug) setState({ previewEntitySlug: null })
    } catch (e: any) {
      alert('Error: ' + (e as any).message)
    }
  }

  // ---- modal builder helpers ----

  private _modal(
    title: string,
    builder: (form: HTMLElement, close: () => void, err: (msg: string) => void) => void
  ): HTMLElement {
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'
    const box = document.createElement('div')
    box.className = 'modal-box'
    const hdr = document.createElement('div')
    hdr.className = 'modal-header'
    const h2 = document.createElement('h2')
    h2.textContent = title
    hdr.appendChild(h2)
    const closeBtn = document.createElement('button')
    closeBtn.className = 'modal-close'
    closeBtn.textContent = 'x'
    const close = () => overlay.remove()
    closeBtn.onclick = close
    hdr.appendChild(closeBtn)
    box.appendChild(hdr)
    const errEl = document.createElement('div')
    errEl.className = 'modal-error'
    box.appendChild(errEl)
    const form = document.createElement('div')
    form.className = 'modal-form'
    box.appendChild(form)
    overlay.appendChild(box)
    overlay.onclick = (e) => { if (e.target === overlay) close() }
    builder(form, close, (msg) => { errEl.textContent = msg })
    return overlay
  }

  private _field(parent: HTMLElement, label: string, type: string, placeholder: string): HTMLInputElement {
    const lbl = document.createElement('label')
    lbl.className = 'modal-field-label'
    lbl.textContent = label
    parent.appendChild(lbl)
    const input = document.createElement('input')
    input.type = type
    input.placeholder = placeholder
    input.className = 'modal-input'
    parent.appendChild(input)
    return input
  }

  private _submitBtn(parent: HTMLElement, label: string, handler: () => Promise<void>) {
    const btn = document.createElement('button')
    btn.className = 'modal-submit'
    btn.textContent = label
    btn.onclick = async () => {
      btn.disabled = true
      await handler().finally(() => { btn.disabled = false })
    }
    parent.appendChild(btn)
  }
}
