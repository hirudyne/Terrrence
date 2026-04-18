import { api, EntityDetail, Asset } from './api'
import { blobToWav, startRecording } from './audio-utils'
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
      const [detail, assets, tags, backlinks] = await Promise.all([
        api.getEntity(state.projectSlug, slug),
        api.listEntityAssets(state.projectSlug, slug),
        api.listEntityTags(state.projectSlug, slug),
        api.getBacklinks(state.projectSlug, slug),
      ])
      const locations = detail.type === 'character'
        ? await api.listEntities(state.projectSlug, 'location')
        : []
      this._lastSnapshot = JSON.stringify({ body: detail.body, assets: assets.map(a => a.id), tags: tags.map(t => t.id) })
      this._render(detail, assets, tags, backlinks, locations)
      this.pollTimer = setInterval(async () => {
        const s = getState()
        if (!s.projectSlug || !this.currentSlug) return
        try {
          const [d, a, t, bl] = await Promise.all([
            api.getEntity(s.projectSlug, this.currentSlug),
            api.listEntityAssets(s.projectSlug, this.currentSlug),
            api.listEntityTags(s.projectSlug, this.currentSlug),
            api.getBacklinks(s.projectSlug, this.currentSlug),
          ])
          const snapshot = JSON.stringify({ body: d.body, assets: a.map((x: Asset) => x.id), tags: t.map((x: {id:number}) => x.id) })
          if (snapshot !== this._lastSnapshot && !this.el.querySelector('.game-settings-input:focus, .preview-body-edit:focus') && !this._generating) {
            this._lastSnapshot = snapshot
            const locs = d.type === 'character' ? await api.listEntities(s.projectSlug!, 'location') : []
            this._render(d, a, t, bl, locs)
          }
        } catch (_) {}
      }, 2000)
    } catch (e: any) {
      this.el.innerHTML = `<div class="preview-error">Error: ${e.message}</div>`
    }
  }

  private _render(detail: EntityDetail, assets: Asset[], tags: {id:number;name:string}[], backlinks: {slug:string;type:string;display_name:string;occurrences:number}[] = [], locations: import('./api').Entity[] = []) {
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
      this.el.appendChild(this._renderCharacterSettings(detail, state.projectSlug!, locations))
    }

    // -- location settings (scene image selector) --
    if (detail.type === 'location') {
      this.el.appendChild(this._renderLocationSettings(detail, assets, state.projectSlug!))
    }

    // -- tags --
    const tagSection = document.createElement('div')
    tagSection.className = 'preview-tags'
    this._renderTags(tagSection, tags, detail.slug, state.projectSlug!)
    this.el.appendChild(tagSection)

    // -- backlinks --
    if (backlinks.length > 0) {
      const blSection = document.createElement('div')
      blSection.className = 'preview-backlinks'
      const blHeading = document.createElement('div')
      blHeading.className = 'preview-section-heading'
      blHeading.textContent = `Referenced by (${backlinks.length})`
      blSection.appendChild(blHeading)
      const blList = document.createElement('div')
      blList.className = 'preview-backlinks-list'
      const TYPE_PREFIX_BL: Record<string,string> = { location:'@@', character:'##', item:'~~', chapter:'??', event:'!!', conversation:'\u201c\u201d', game:'G', spot:'%%' }
      for (const bl of backlinks) {
        const chip = document.createElement('button')
        chip.className = 'backlink-chip'
        chip.title = bl.slug
        chip.textContent = `${TYPE_PREFIX_BL[bl.type] ?? ''} ${bl.display_name}`
        chip.onclick = () => setState({ previewEntitySlug: bl.slug })
        blList.appendChild(chip)
      }
      blSection.appendChild(blList)
      this.el.appendChild(blSection)
    }

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


  private _renderLocationSettings(detail: EntityDetail, assets: Asset[], projectSlug: string): HTMLElement {
    const section = document.createElement('div')
    section.className = 'game-settings'

    const heading = document.createElement('div')
    heading.className = 'preview-section-heading'
    heading.textContent = 'Location Settings'
    section.appendChild(heading)

    const label = document.createElement('label')
    label.className = 'modal-field-label'
    label.textContent = 'Scene image'
    section.appendChild(label)

    const imageAssets = assets.filter(a => a.mime.startsWith('image/'))
    const currentId = (detail.meta as Record<string, unknown>)?.['scene_image'] as number | null ?? null

    const select = document.createElement('select')
    select.className = 'modal-select'

    const noneOpt = document.createElement('option')
    noneOpt.value = ''
    noneOpt.textContent = '(none)'
    select.appendChild(noneOpt)

    for (const a of imageAssets) {
      const opt = document.createElement('option')
      opt.value = String(a.id)
      opt.textContent = a.rel_path.split('/').pop() ?? a.rel_path
      if (a.id === currentId) opt.selected = true
      select.appendChild(opt)
    }
    if (imageAssets.length === 0) {
      const opt = document.createElement('option')
      opt.textContent = 'No image assets yet'
      opt.disabled = true
      select.appendChild(opt)
    }

    let _saveTimer: ReturnType<typeof setTimeout> | null = null
    select.onchange = () => {
      if (_saveTimer) clearTimeout(_saveTimer)
      _saveTimer = setTimeout(async () => {
        const val = select.value === '' ? '' : Number(select.value)
        try {
          await api.updateEntityMeta(projectSlug, detail.slug, { scene_image: val === '' ? '' : val })
        } catch (e) { console.debug('[terrrence] scene_image save error', e) }
      }, 400)
    }
    section.appendChild(select)
    return section
  }

  private _renderCharacterSettings(detail: EntityDetail, projectSlug: string, locations: import('./api').Entity[] = []): HTMLElement {
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


    // Start location
    const slHeading = document.createElement('div')
    slHeading.className = 'game-settings-heading'
    slHeading.textContent = 'Start Location'
    section.appendChild(slHeading)

    const startLocMeta = (detail.meta as Record<string, unknown>)?.['start_location'] as {location?: string; x?: number; y?: number} | undefined ?? {}

    const locRow = document.createElement('div')
    locRow.className = 'start-loc-row'

    const locSel = document.createElement('select')
    locSel.className = 'modal-select'
    const noneOpt = document.createElement('option')
    noneOpt.value = ''
    noneOpt.textContent = '(none)'
    locSel.appendChild(noneOpt)
    for (const loc of locations) {
      const opt = document.createElement('option')
      opt.value = loc.slug
      opt.textContent = loc.display_name
      if (loc.slug === startLocMeta.location) opt.selected = true
      locSel.appendChild(opt)
    }
    locRow.appendChild(locSel)
    section.appendChild(locRow)

    const xyRow = document.createElement('div')
    xyRow.className = 'start-loc-xy-row'

    const mkXY = (label: string, key: 'x' | 'y') => {
      const wrap = document.createElement('div')
      wrap.className = 'start-loc-xy-field'
      const lbl = document.createElement('label')
      lbl.className = 'modal-field-label'
      lbl.textContent = label
      const inp = document.createElement('input')
      inp.type = 'number'
      inp.className = 'modal-input start-loc-xy-input'
      inp.min = '0'; inp.max = '1'; inp.step = '0.01'
      inp.value = startLocMeta[key] !== undefined ? String(startLocMeta[key]) : '0.5'
      wrap.appendChild(lbl)
      wrap.appendChild(inp)
      xyRow.appendChild(wrap)
      return inp
    }
    const xInp = mkXY('X', 'x')
    const yInp = mkXY('Y', 'y')
    section.appendChild(xyRow)

    let _slTimer: ReturnType<typeof setTimeout> | null = null
    const _saveStartLoc = () => {
      if (_slTimer) clearTimeout(_slTimer)
      _slTimer = setTimeout(async () => {
        const locVal = locSel.value
        if (!locVal) {
          try { await api.updateEntityMeta(projectSlug, detail.slug, { start_location: '' }) } catch (_) {}
          return
        }
        const x = Math.max(0, Math.min(1, parseFloat(xInp.value) || 0.5))
        const y = Math.max(0, Math.min(1, parseFloat(yInp.value) || 0.5))
        try {
          await api.updateEntityMeta(projectSlug, detail.slug, { start_location: { location: locVal, x, y } })
        } catch (e) { console.debug('[terrrence] start_location save error', e) }
      }, 800)
    }
    locSel.onchange = _saveStartLoc
    xInp.oninput = _saveStartLoc
    yInp.oninput = _saveStartLoc

    // Voice reference recording
    section.appendChild(this._renderVoiceRecorder(detail.slug, projectSlug))

    return section
  }

  private _renderVoiceRecorder(characterSlug: string, projectSlug: string): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'voice-recorder'

    const heading = document.createElement('div')
    heading.className = 'game-settings-heading'
    heading.textContent = 'Voice Reference'
    wrap.appendChild(heading)

    const status = document.createElement('div')
    status.className = 'voice-recorder-status'
    wrap.appendChild(status)

    const btnRow = document.createElement('div')
    btnRow.className = 'voice-recorder-btns'
    wrap.appendChild(btnRow)

    const previewAudio = document.createElement('audio')
    previewAudio.controls = true
    previewAudio.className = 'voice-recorder-preview'
    previewAudio.style.display = 'none'
    wrap.appendChild(previewAudio)

    let recordedBlob: Blob | null = null

    const recordBtn = document.createElement('button')
    recordBtn.className = 'asset-btn'
    recordBtn.textContent = '⏺ Record'

    const stopBtn = document.createElement('button')
    stopBtn.className = 'asset-btn'
    stopBtn.textContent = '⏹ Stop'
    stopBtn.style.display = 'none'

    const uploadBtn = document.createElement('button')
    uploadBtn.className = 'asset-btn asset-btn-generate'
    uploadBtn.textContent = 'Register voice'
    uploadBtn.style.display = 'none'

    const deleteBtn = document.createElement('button')
    deleteBtn.className = 'asset-btn'
    deleteBtn.textContent = 'Delete voice'
    deleteBtn.style.display = 'none'
    deleteBtn.style.borderColor = 'var(--danger)'
    deleteBtn.style.color = 'var(--danger)'

    btnRow.appendChild(recordBtn)
    btnRow.appendChild(stopBtn)
    btnRow.appendChild(uploadBtn)
    btnRow.appendChild(deleteBtn)

    // Check if voice already registered
    api.listVoices(projectSlug).then(({ voices }) => {
      if (voices.includes(characterSlug)) {
        status.textContent = 'Voice registered'
        status.dataset.state = 'ok'
        deleteBtn.style.display = 'inline-block'
      } else {
        status.textContent = 'No voice registered'
        status.dataset.state = 'none'
      }
    }).catch(() => { status.textContent = 'Could not reach voice service' })

    let _stopRecording: (() => Promise<Blob>) | null = null

    recordBtn.onclick = async () => {
      try {
        recordedBlob = null
        previewAudio.style.display = 'none'
        uploadBtn.style.display = 'none'
        const rec = await startRecording()
        _stopRecording = rec.stop
        recordBtn.style.display = 'none'
        stopBtn.style.display = 'inline-block'
        status.textContent = 'Recording...'
        status.dataset.state = 'recording'
      } catch (e: any) {
        status.textContent = `Mic error: ${e?.message ?? e}`
      }
    }

    stopBtn.onclick = async () => {
      if (!_stopRecording) return
      stopBtn.style.display = 'none'
      recordBtn.style.display = 'inline-block'
      recordedBlob = await _stopRecording()
      _stopRecording = null
      const url = URL.createObjectURL(recordedBlob)
      previewAudio.src = url
      previewAudio.style.display = 'block'
      uploadBtn.style.display = 'inline-block'
      status.textContent = 'Recording ready - preview and register'
      status.dataset.state = 'ready'
    }

    uploadBtn.onclick = async () => {
      if (!recordedBlob) return
      uploadBtn.disabled = true
      uploadBtn.textContent = 'Converting...'
      try {
        const wavBuf = await blobToWav(recordedBlob)
        uploadBtn.textContent = 'Registering...'
        await api.registerVoice(projectSlug, characterSlug, wavBuf)
        status.textContent = 'Voice registered'
        status.dataset.state = 'ok'
        uploadBtn.style.display = 'none'
        deleteBtn.style.display = 'inline-block'
        previewAudio.style.display = 'none'
      } catch (e: any) {
        status.textContent = `Registration failed: ${e?.message ?? e}`
      } finally {
        uploadBtn.disabled = false
        uploadBtn.textContent = 'Register voice'
      }
    }

    deleteBtn.onclick = async () => {
      if (!confirm('Delete registered voice for this character?')) return
      deleteBtn.disabled = true
      try {
        await api.deleteVoice(projectSlug, characterSlug)
        status.textContent = 'No voice registered'
        status.dataset.state = 'none'
        deleteBtn.style.display = 'none'
      } catch (e: any) {
        status.textContent = `Delete failed: ${e?.message ?? e}`
      } finally {
        deleteBtn.disabled = false
      }
    }

    return wrap
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
