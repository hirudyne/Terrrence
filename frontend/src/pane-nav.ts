import { api, Entity } from './api'
import { getState, setState, subscribe } from './state'
import { showLogin } from './login'

type ViewMode = 'tree' | 'tabs'

const ALL_TYPES = ['game', 'chapter', 'location', 'character', 'item', 'event'] as const
const TYPE_PREFIX: Record<string, string> = {
  game:      'G',
  chapter:   '??',
  location:  '@',
  character: '#',
  item:      '~',
  event:     '!!',
}
// Types available in the "new entity" dropdown - game is conditional
const CREATABLE_TYPES = ['chapter', 'location', 'character', 'item', 'event'] as const

export class NavPane {
  private el: HTMLElement
  private mode: ViewMode = 'tree'
  private entities: Entity[] = []
  private selectedType: string = 'location'

  constructor(container: HTMLElement) {
    this.el = container
    this.el.className = 'nav-pane'
    subscribe(state => {
      if (state.projectSlug) this.load(state.projectSlug)
    })
    this._render()
  }

  async load(projectSlug: string) {
    this.entities = await api.listEntities(projectSlug)
    this._render()
  }

  private _render() {
    const state = getState()
    this.el.innerHTML = ''

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
      const loginEl = showLogin(() => {
        loginEl.remove()
        const layoutEl = document.getElementById('layout-root')
        if (layoutEl) layoutEl.innerHTML = ''
        window.location.reload()
      })
      document.getElementById('app')!.appendChild(loginEl)
    }
    header.appendChild(logoutBtn)

    this.el.appendChild(header)

    if (!state.projectSlug) {
      this.el.appendChild(this._projectSelector())
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
  }

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

    // Game entity at the top, with chapters as children
    const gameEntity = this.entities.find(e => e.type === 'game')
    if (gameEntity) {
      const chapters = this.entities.filter(e => e.type === 'chapter')
      ul.appendChild(this._gameGroup(gameEntity, chapters))
    }

    // Remaining types
    for (const type of (['location', 'character', 'item', 'event'] as const)) {
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
    return ul
  }

  private _gameGroup(game: Entity, chapters: Entity[]): HTMLElement {
    const li = document.createElement('li')
    li.className = 'nav-group'

    const label = document.createElement('span')
    label.className = 'nav-group-label nav-group-label--game'
    label.textContent = `G ${game.display_name}`
    label.title = game.slug
    label.style.cursor = 'pointer'
    label.onclick = () => setState({ activeEntitySlug: game.slug })

    const previewBtn = document.createElement('span')
    previewBtn.className = 'nav-preview-btn'
    previewBtn.textContent = '>'
    previewBtn.title = 'Open in preview'
    previewBtn.onclick = (e) => { e.stopPropagation(); setState({ previewEntitySlug: game.slug }) }
    label.appendChild(previewBtn)
    li.appendChild(label)

    const children = document.createElement('ul')
    for (const chapter of chapters) children.appendChild(this._entityItem(chapter))
    li.appendChild(children)
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

  // ---- entity item ----

  private _entityItem(entity: Entity): HTMLElement {
    const li = document.createElement('li')
    li.className = 'nav-entity-item'
    const state = getState()
    if (entity.slug === state.activeEntitySlug) li.classList.add('active')

    const nameSpan = document.createElement('span')
    nameSpan.className = 'nav-entity-name'
    nameSpan.textContent = entity.display_name
    nameSpan.title = entity.slug
    li.appendChild(nameSpan)

    li.onclick = () => setState({ activeEntitySlug: entity.slug })

    const actions = document.createElement('span')
    actions.className = 'nav-entity-actions'

    const previewBtn = document.createElement('span')
    previewBtn.className = 'nav-action-btn'
    previewBtn.textContent = '>'
    previewBtn.title = 'Open in preview'
    previewBtn.onclick = (e) => { e.stopPropagation(); setState({ previewEntitySlug: entity.slug }) }
    actions.appendChild(previewBtn)

    if (entity.type !== 'game') {
      const delBtn = document.createElement('span')
      delBtn.className = 'nav-action-btn nav-action-btn--danger'
      delBtn.textContent = 'x'
      delBtn.title = 'Delete'
      delBtn.onclick = (e) => { e.stopPropagation(); this._confirmDelete(entity) }
      actions.appendChild(delBtn)
    }

    li.appendChild(actions)
    return li
  }

  // ---- modals ----

  private _showProjectModal() {
    const modal = this._modal('Projects', (form, close, err) => {
      // -- existing projects list --
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
            btn.onclick = () => {
              setState({ projectSlug: p.slug, projectName: p.display_name })
              close()
            }
            listWrap.appendChild(btn)
          }
        }
      }).catch(() => { listWrap.textContent = 'Failed to load.' })

      // -- divider --
      const div = document.createElement('div')
      div.className = 'modal-divider'
      div.textContent = 'or create new'
      form.appendChild(div)

      // -- create form --
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

    const modal = this._modal('New entity', (form, close, err) => {
      // type dropdown
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

      const slugInput  = this._field(form, 'Slug', 'text', 'e.g. C1 or old_barn')
      const nameInput  = this._field(form, 'Display name', 'text', 'e.g. Chapter 1 - Bundle Beginnings')

      this._submitBtn(form, 'Create', async () => {
        const type = typeSelect.value
        const slug = slugInput.value.trim()
        const name = nameInput.value.trim()
        if (!slug || !name) { err('Slug and display name required.'); return }
        try {
          await api.createEntity(state.projectSlug!, { slug, display_name: name, type })
          await this.load(state.projectSlug!)
          setState({ activeEntitySlug: slug })
          close()
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
      await this.load(state.projectSlug)
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
