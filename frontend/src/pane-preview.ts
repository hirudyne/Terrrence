import { api, EntityDetail, Asset } from './api'
import { getState, setState, subscribe } from './state'

const TYPE_PREFIX: Record<string, string> = {
  location:     '@',
  character:    '#',
  item:         '~',
  event:        '!!',
  game:         'G',
  chapter:      'Ch',
  conversation: '“”',
}

const TOKEN_RE = /(@@[^@]+@@|##[^#]+##|~~[^~]+~~|!!(?:[^!]|![^!])*!!|\?\?[^?]+\?\?|\u201c\u201c[^\u201c\u201d]+\u201d\u201d)/g

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function deriveSlug(displayName: string, entityType?: string): string {
  if (entityType === 'chapter' || /^[Cc]hapter\s+\d/.test(displayName)) {
    const m = displayName.match(/^[Cc]hapter\s+(\d+)/)
    if (m) return `C${m[1]}`
  }
  const ascii = displayName.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  const slug = ascii.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return slug.slice(0, 64) || 'entity'
}

function renderBody(body: string): string {
  return body.replace(TOKEN_RE, (match) => {
    let slug: string
    let display: string
    let cssClass: string
    if (match.startsWith('@@'))      { display = match.slice(2, -2); slug = deriveSlug(display); cssClass = 'ref-location' }
    else if (match.startsWith('##')) { display = match.slice(2, -2); slug = deriveSlug(display); cssClass = 'ref-character' }
    else if (match.startsWith('~~')) { display = match.slice(2, -2); slug = deriveSlug(display); cssClass = 'ref-item' }
    else if (match.startsWith('??'))    { display = match.slice(2, -2); slug = deriveSlug(display, 'chapter'); cssClass = 'ref-chapter' }
    else if (match.startsWith('“')) { display = match.slice(1, -1); slug = deriveSlug(display); cssClass = 'ref-conversation' }
    else { return `<span class="ref-event">${escapeHtml(match)}</span>` }
    return `<a class="ref-link ${cssClass}" data-slug="${slug}" href="#">${escapeHtml(display)}</a>`
  })
}

function markdownToHtml(md: string): string {
  return md.split(/\n{2,}/)
    .map(p => `<p>${renderBody(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n')
}

function isImage(mime: string) { return mime.startsWith('image/') }
function isAudio(mime: string) { return mime.startsWith('audio/') }

export class PreviewPane {
  private el: HTMLElement
  private currentSlug: string | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null

  constructor(container: HTMLElement) {
    this.el = container
    this.el.className = 'preview-pane'
    subscribe(state => {
      if (state.previewEntitySlug !== this.currentSlug) {
        this._load(state.previewEntitySlug)
      }
    })
    this._renderEmpty()
  }

  private _renderEmpty() {
    this.el.innerHTML = '<div class="preview-empty">Select an entity to preview.</div>'
  }

  private async _load(slug: string | null) {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null }
    this.currentSlug = slug
    if (!slug) { this._renderEmpty(); return }
    const state = getState()
    if (!state.projectSlug) return
    try {
      const [detail, assets, tags] = await Promise.all([
        api.getEntity(state.projectSlug, slug),
        api.listEntityAssets(state.projectSlug, slug),
        api.listEntityTags(state.projectSlug, slug),
      ])
      this._render(detail, assets, tags)
      this.pollTimer = setInterval(async () => {
        const s = getState()
        if (!s.projectSlug || !this.currentSlug) return
        try {
          const [d, a, t] = await Promise.all([
            api.getEntity(s.projectSlug, this.currentSlug),
            api.listEntityAssets(s.projectSlug, this.currentSlug),
            api.listEntityTags(s.projectSlug, this.currentSlug),
          ])
          // Don't re-render if user is actively editing a settings field
          if (!this.el.querySelector('.game-settings-input:focus')) {
            this._render(d, a, t)
          }
        } catch (_) {}
      }, 2000)
    } catch (e: any) {
      this.el.innerHTML = `<div class="preview-error">Error: ${e.message}</div>`
    }
  }

  private _render(detail: EntityDetail, assets: Asset[], tags: {id:number;name:string}[]) {
    const state = getState()
    this.el.innerHTML = ''

    // -- header --
    const header = document.createElement('div')
    header.className = 'preview-header'
    header.innerHTML = `
      <span class="preview-type-badge ${detail.type}">${TYPE_PREFIX[detail.type] ?? ''}</span>
      <span class="preview-title">${escapeHtml(detail.display_name)}</span>
      <span class="preview-slug">${escapeHtml(detail.slug)}</span>`
    this.el.appendChild(header)

    // -- body --
    const body = document.createElement('div')
    body.className = 'preview-body'
    body.innerHTML = markdownToHtml(detail.body)
    body.querySelectorAll<HTMLAnchorElement>('a.ref-link').forEach(a => {
      a.onclick = (e) => { e.preventDefault(); setState({ previewEntitySlug: a.dataset.slug ?? null }) }
    })
    this.el.appendChild(body)

    // -- game settings (art style etc) --
    if (detail.type === 'game') {
      this.el.appendChild(this._renderGameSettings(detail, state.projectSlug!))
    }

    // -- tags --
    const tagSection = document.createElement('div')
    tagSection.className = 'preview-tags'
    this._renderTags(tagSection, tags, detail.slug, state.projectSlug!)
    this.el.appendChild(tagSection)

    // -- assets --
    const assetSection = document.createElement('div')
    assetSection.className = 'preview-assets'

    const assetHeader = document.createElement('div')
    assetHeader.className = 'preview-assets-header'
    assetHeader.textContent = `Assets (${assets.length})`
    assetSection.appendChild(assetHeader)

    if (assets.length > 0) {
      const grid = document.createElement('div')
      grid.className = 'asset-grid'
      for (const asset of assets) {
        grid.appendChild(this._assetTile(asset, detail.slug, state.projectSlug!))
      }
      assetSection.appendChild(grid)
    }

    // Upload + associate controls
    assetSection.appendChild(this._assetControls(detail.slug, state.projectSlug!, detail.type))
    this.el.appendChild(assetSection)
  }

  private _renderTags(
    container: HTMLElement,
    tags: {id:number;name:string}[],
    entitySlug: string,
    projectSlug: string,
  ) {
    const wrap = document.createElement('div')
    wrap.className = 'tag-wrap'

    for (const tag of tags) {
      const chip = document.createElement('span')
      chip.className = 'tag-chip'
      chip.textContent = tag.name
      const rm = document.createElement('span')
      rm.className = 'tag-chip-remove'
      rm.textContent = 'x'
      rm.onclick = async () => {
        await api.removeEntityTag(projectSlug, entitySlug, tag.name).catch(() => {})
        setState({ previewEntitySlug: this.currentSlug })
      }
      chip.appendChild(rm)
      wrap.appendChild(chip)
    }

    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'tag-input'
    input.placeholder = '+ add tag'
    const addTag = async () => {
      const name = input.value.trim()
      if (!name) return
      input.value = ''
      await api.addEntityTag(projectSlug, entitySlug, name).catch(() => {})
      setState({ previewEntitySlug: this.currentSlug })
    }
    input.onkeydown = (e) => { if (e.key === 'Enter') addTag() }
    input.onblur = () => { if (input.value.trim()) addTag() }
    wrap.appendChild(input)
    container.appendChild(wrap)
  }

  private _assetTile(asset: Asset, entitySlug: string, projectSlug: string): HTMLElement {
    const tile = document.createElement('div')
    tile.className = 'asset-tile'

    const url = api.assetFileUrl(projectSlug, asset.id)

    if (isImage(asset.mime)) {
      const img = document.createElement('img')
      img.src = url
      img.className = 'asset-img'
      img.title = asset.rel_path
      tile.appendChild(img)
    } else if (isAudio(asset.mime)) {
      const audio = document.createElement('audio')
      audio.controls = true
      audio.src = url
      audio.className = 'asset-audio'
      tile.appendChild(audio)
    } else {
      const icon = document.createElement('div')
      icon.className = 'asset-file-icon'
      icon.textContent = asset.rel_path.split('/').pop() ?? asset.rel_path
      tile.appendChild(icon)
    }

    const meta = document.createElement('div')
    meta.className = 'asset-meta'
    const name = asset.rel_path.split('/').pop() ?? asset.rel_path
    meta.innerHTML = `<span class="asset-name" title="${escapeHtml(asset.rel_path)}">${escapeHtml(name)}</span>`
    if (asset.role) {
      const role = document.createElement('span')
      role.className = 'asset-role'
      role.textContent = asset.role
      meta.appendChild(role)
    }
    tile.appendChild(meta)

    const removeBtn = document.createElement('button')
    removeBtn.className = 'asset-remove'
    removeBtn.title = 'Remove association'
    removeBtn.textContent = 'x'
    removeBtn.onclick = async () => {
      try {
        await api.disassociateAsset(projectSlug, entitySlug, asset.id)
        setState({ previewEntitySlug: this.currentSlug }) // reload
      } catch (e: any) { alert(e.message) }
    }
    tile.appendChild(removeBtn)

    return tile
  }

  private _renderGameSettings(detail: EntityDetail, projectSlug: string): HTMLElement {
    const MAX = 300
    const section = document.createElement('div')
    section.className = 'game-settings'

    const heading = document.createElement('div')
    heading.className = 'game-settings-heading'
    heading.textContent = 'Art Style'
    section.appendChild(heading)

    const input = document.createElement('textarea')
    input.className = 'modal-input game-settings-input'
    input.placeholder = 'e.g. painterly watercolour, muted earth tones, Hayao Miyazaki, Edward Gorey'
    input.maxLength = MAX
    input.value = (detail.meta as Record<string, string>)?.['art_style'] ?? ''

    const counter = document.createElement('div')
    counter.className = 'game-settings-counter'
    const update = () => { counter.textContent = `${input.value.length} / ${MAX}` }
    update()

    let saveTimer: ReturnType<typeof setTimeout> | null = null
    input.oninput = () => {
      update()
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(async () => {
        try {
          await api.updateEntityMeta(projectSlug, detail.slug, { art_style: input.value.trim() })
          console.debug('[terrrence] art_style saved', input.value)
        } catch (e) {
          console.debug('[terrrence] art_style save error', e)
        }
      }, 800)
    }

    section.appendChild(input)
    section.appendChild(counter)
    return section
  }

  private _assetControls(entitySlug: string, projectSlug: string, entityType: string): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'asset-controls'

    // Generate image (location, character, item only)
    const IMAGE_TYPES = new Set(['location', 'character', 'item'])
    if (IMAGE_TYPES.has(entityType)) {
      const genBtn = document.createElement('button')
      genBtn.className = 'asset-btn asset-btn-generate'
      genBtn.textContent = '+ Generate image'
      genBtn.onclick = async () => {
        genBtn.disabled = true
        genBtn.textContent = 'Generating...'
        try {
          await api.generateImage(projectSlug, entitySlug)
          setState({ previewEntitySlug: this.currentSlug }) // reload
        } catch (e: any) {
          alert('Image generation failed: ' + (e.message ?? e))
        } finally {
          genBtn.disabled = false
          genBtn.textContent = '+ Generate image'
        }
      }
      wrap.appendChild(genBtn)
    }

    // Upload new file
    const uploadInput = document.createElement('input')
    uploadInput.type = 'file'
    uploadInput.id = 'asset-upload-input'
    uploadInput.style.display = 'none'
    uploadInput.multiple = false

    const uploadBtn = document.createElement('button')
    uploadBtn.className = 'asset-btn'
    uploadBtn.textContent = '+ Upload & attach'
    uploadBtn.onclick = () => uploadInput.click()

    uploadInput.onchange = async () => {
      const file = uploadInput.files?.[0]
      if (!file) return
      uploadBtn.disabled = true
      uploadBtn.textContent = 'Uploading...'
      try {
        const formData = new FormData()
        formData.append('file', file)
        const res = await fetch(`/projects/${projectSlug}/assets`, {
          method: 'POST', credentials: 'include', body: formData,
        })
        if (!res.ok) throw new Error((await res.json()).detail)
        const uploaded = await res.json()
        await api.associateAsset(projectSlug, entitySlug, uploaded.id)
        setState({ previewEntitySlug: this.currentSlug }) // reload
      } catch (e: any) {
        alert('Upload failed: ' + e.message)
      } finally {
        uploadBtn.disabled = false
        uploadBtn.textContent = '+ Upload & attach'
        uploadInput.value = ''
      }
    }

    wrap.appendChild(uploadInput)
    wrap.appendChild(uploadBtn)

    // Attach existing asset by id
    const attachRow = document.createElement('div')
    attachRow.className = 'asset-attach-row'
    const attachInput = document.createElement('input')
    attachInput.type = 'number'
    attachInput.placeholder = 'Asset ID'
    attachInput.className = 'modal-input'
    attachInput.style.width = '80px'
    const roleInput = document.createElement('input')
    roleInput.type = 'text'
    roleInput.placeholder = 'Role (sprite, voice...)'
    roleInput.className = 'modal-input'
    roleInput.style.flex = '1'
    const attachBtn = document.createElement('button')
    attachBtn.className = 'asset-btn'
    attachBtn.textContent = 'Attach'
    attachBtn.onclick = async () => {
      const id = parseInt(attachInput.value)
      if (!id) return
      try {
        await api.associateAsset(projectSlug, entitySlug, id, roleInput.value.trim() || undefined)
        setState({ previewEntitySlug: this.currentSlug })
      } catch (e: any) { alert(e.message) }
    }
    attachRow.append(attachInput, roleInput, attachBtn)
    wrap.appendChild(attachRow)

    return wrap
  }
}
