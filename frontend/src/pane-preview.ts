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

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function isImage(mime: string) { return mime.startsWith('image/') }
function isAudio(mime: string) { return mime.startsWith('audio/') }

export class PreviewPane {
  private el: HTMLElement
  private currentSlug: string | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private _lastSnapshot: string = ''
  private _generating: boolean = false

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
      this._lastSnapshot = JSON.stringify({ body: detail.body, assets: assets.map(a => a.id), tags: tags.map(t => t.id) })
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
          const snapshot = JSON.stringify({ body: d.body, assets: a.map((x: Asset) => x.id), tags: t.map((x: {id:number}) => x.id) })
          if (snapshot !== this._lastSnapshot && !this.el.querySelector('.game-settings-input:focus, .preview-body-edit:focus') && !this._generating) {
            this._lastSnapshot = snapshot
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

    const typeBadge = document.createElement('span')
    typeBadge.className = `preview-type-badge ${detail.type}`
    typeBadge.textContent = TYPE_PREFIX[detail.type] ?? ''
    header.appendChild(typeBadge)

    const nameInput = document.createElement('input')
    nameInput.type = 'text'
    nameInput.className = 'preview-title-input'
    nameInput.value = detail.display_name
    nameInput.spellcheck = false
    nameInput.title = 'Edit display name'

    const slugSpan = document.createElement('span')
    slugSpan.className = 'preview-slug'
    slugSpan.textContent = detail.slug

    let _renameTimer: ReturnType<typeof setTimeout> | null = null
    let _currentSlug = detail.slug

    nameInput.oninput = () => {
      if (_renameTimer) clearTimeout(_renameTimer)
      _renameTimer = setTimeout(async () => {
        const newName = nameInput.value.trim()
        if (!newName || newName === detail.display_name) return
        const project = getState().projectSlug
        if (!project) return
        try {
          const result = await api.renameEntity(project, _currentSlug, newName)
          detail.display_name = result.display_name
          _currentSlug = result.slug
          slugSpan.textContent = result.slug
          // If slug changed, update state so editor tabs etc. reflect new slug
          if (result.slug !== detail.slug) {
            detail.slug = result.slug
            setState({ previewEntitySlug: result.slug })
          }
        } catch (e: any) {
          nameInput.value = detail.display_name
          console.error('[terrrence] rename failed', e)
        }
      }, 800)
    }

    header.appendChild(nameInput)
    header.appendChild(slugSpan)
    this.el.appendChild(header)

    // -- body --
    const body = document.createElement('textarea')
    body.className = 'preview-body-edit'
    body.value = detail.body
    body.spellcheck = false
    let _bodyTimer: ReturnType<typeof setTimeout> | null = null
    body.oninput = () => {
      if (_bodyTimer) clearTimeout(_bodyTimer)
      _bodyTimer = setTimeout(async () => {
        try {
          await api.updateEntity(state.projectSlug!, detail.slug, { body: body.value })
          // Update snapshot so poll doesn't re-render while editing
          this._lastSnapshot = JSON.stringify({ body: body.value, assets: [], tags: [] })
          console.debug('[terrrence] preview body saved', detail.slug)
        } catch (e) { console.debug('[terrrence] preview body save error', e) }
      }, 800)
    }
    this.el.appendChild(body)

    // -- game settings (art style etc) --
    if (detail.type === 'game') {
      this.el.appendChild(this._renderGameSettings(detail, state.projectSlug!))
    }

    // -- character settings (physical appearance, voice description) --
    if (detail.type === 'character') {
      this.el.appendChild(this._renderCharacterSettings(detail, state.projectSlug!))
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
      img.style.cursor = 'zoom-in'
      img.onclick = () => {
        const overlay = document.createElement('div')
        overlay.className = 'asset-lightbox'
        const full = document.createElement('img')
        full.src = url
        full.className = 'asset-lightbox-img'
        overlay.appendChild(full)
        overlay.onclick = () => overlay.remove()
        document.body.appendChild(overlay)
      }
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

  private _renderCharacterSettings(detail: EntityDetail, projectSlug: string): HTMLElement {
    const section = document.createElement('div')
    section.className = 'game-settings'

    const mkField = (labelText: string, metaKey: string, placeholder: string, maxLen: number) => {
      const heading = document.createElement('div')
      heading.className = 'game-settings-heading'
      heading.textContent = labelText
      section.appendChild(heading)

      const input = document.createElement('textarea')
      input.className = 'modal-input game-settings-input'
      input.placeholder = placeholder
      input.maxLength = maxLen
      input.value = (detail.meta as Record<string, string>)?.[metaKey] ?? ''

      const counter = document.createElement('div')
      counter.className = 'game-settings-counter'
      const update = () => { counter.textContent = `${input.value.length} / ${maxLen}` }
      update()

      let saveTimer: ReturnType<typeof setTimeout> | null = null
      input.oninput = () => {
        update()
        if (saveTimer) clearTimeout(saveTimer)
        saveTimer = setTimeout(async () => {
          try {
            await api.updateEntityMeta(projectSlug, detail.slug, { [metaKey]: input.value.trim() })
          } catch (e) { console.debug('[terrrence] char settings save error', e) }
        }, 800)
      }

      section.appendChild(input)
      section.appendChild(counter)
    }

    mkField(
      'Physical Appearance',
      'physical_appearance',
      'e.g. tall, weathered skin, grey stubble, wears a canvas jacket',
      500
    )
    mkField(
      'Voice Description',
      'voice_description',
      'e.g. a gruff older male voice, slow deliberate speech, slight northern accent, close-sounding environment',
      300
    )

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

      const genError = document.createElement('div')
      genError.className = 'gen-error'
      genError.style.display = 'none'

      genBtn.onclick = async () => {
        genBtn.disabled = true
        genBtn.textContent = 'Generating...'
        genError.style.display = 'none'
        genError.textContent = ''
        this._generating = true
        try {
          await api.generateImage(projectSlug, entitySlug)
          setState({ previewEntitySlug: this.currentSlug }) // reload
        } catch (e: any) {
          const msg = e?.message ?? String(e)
          console.debug('[terrrence] generateImage error', e)
          genError.textContent = msg
          genError.style.display = 'block'
        } finally {
          this._generating = false
          genBtn.disabled = false
          genBtn.textContent = '+ Generate image'
        }
      }
      const clipBtn = document.createElement('button')
      clipBtn.className = 'asset-btn asset-btn-clipboard'
      clipBtn.textContent = 'Copy prompt'
      clipBtn.title = 'Copy image generation prompt to clipboard'
      clipBtn.onclick = async () => {
        clipBtn.disabled = true
        clipBtn.textContent = 'Copying...'
        try {
          const { prompt } = await api.getImagePrompt(projectSlug, entitySlug)
          await navigator.clipboard.writeText(prompt)
          clipBtn.textContent = 'Copied!'
          setTimeout(() => { clipBtn.textContent = 'Copy prompt'; clipBtn.disabled = false }, 1500)
        } catch (e: any) {
          console.debug('[terrrence] getImagePrompt error', e)
          clipBtn.textContent = 'Copy prompt'
          clipBtn.disabled = false
        }
      }

      wrap.appendChild(genBtn)
      wrap.appendChild(clipBtn)
      wrap.appendChild(genError)
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
