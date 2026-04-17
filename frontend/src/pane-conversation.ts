// Conversation editor - replaces CodeMirror for conversation entities.
// Two-column layout: greetings (left), menu tree (right).

import { api } from './api'
import { blobToWav, startRecording } from './audio-utils'
import { getState } from './state'
import {
  ConvData, ConvGreeting, ConvLine, ConvOption,
  allIds, deriveConvId, emptyConvData, parseConvBody, serializeConvBody
} from './conversation-types'

// ---------------------------------------------------------------------------
// TTS timing tracker - stores (chars, seconds) samples, estimates from average rate
// ---------------------------------------------------------------------------

const _TtsTimer = new class {
  private _samples: Array<{ chars: number; secs: number }> = []
  private _storageKey = 'terrrence_tts_timing'

  constructor() {
    try {
      const saved = sessionStorage.getItem(this._storageKey)
      if (saved) this._samples = JSON.parse(saved)
    } catch (_) {}
  }

  record(chars: number, secs: number): void {
    this._samples.push({ chars, secs })
    if (this._samples.length > 50) this._samples.shift()
    try { sessionStorage.setItem(this._storageKey, JSON.stringify(this._samples)) } catch (_) {}
  }

  estimate(chars: number): number {
    if (this._samples.length === 0) return chars * 0.12  // cold fallback ~12ms/char
    const rate = this._samples.reduce((s, x) => s + x.secs / Math.max(1, x.chars), 0) / this._samples.length
    return Math.max(2, chars * rate)
  }
}()

// ---------------------------------------------------------------------------
// Speaker validation
// ---------------------------------------------------------------------------

const SPEAKER_RE = /^##[^#]+##$/

function speakerValid(val: string, cache: { slug: string; type: string; display_name: string }[]): boolean {
  if (!SPEAKER_RE.test(val)) return false
  const inner = val.slice(2, -2).trim()
  return cache.some(e => e.type === 'character' && e.display_name === inner)
}

// ---------------------------------------------------------------------------
// Character autocomplete dropdown
// ---------------------------------------------------------------------------

function attachSpeakerAutocomplete(
  input: HTMLInputElement,
  getCache: () => { slug: string; type: string; display_name: string }[]
): void {
  const list = document.createElement('ul')
  list.className = 'conv-autocomplete'
  list.style.display = 'none'
  input.parentElement!.style.position = 'relative'
  input.insertAdjacentElement('afterend', list)

  const update = () => {
    const val = input.value
    const chars = getCache().filter(e => e.type === 'character')
    const query = val.startsWith('##') ? val.slice(2) : val
    const matches = chars.filter(c =>
      c.display_name.toLowerCase().includes(query.toLowerCase())
    ).slice(0, 8)
    list.innerHTML = ''
    if (matches.length === 0 || val === `##${query}##`) { list.style.display = 'none'; return }
    for (const c of matches) {
      const li = document.createElement('li')
      li.textContent = `##${c.display_name}##`
      li.onmousedown = (e) => {
        e.preventDefault()
        input.value = `##${c.display_name}##`
        input.dispatchEvent(new Event('input'))
        list.style.display = 'none'
      }
      list.appendChild(li)
    }
    list.style.display = 'block'
  }

  input.addEventListener('input', update)
  input.addEventListener('focus', update)
  input.addEventListener('blur', () => setTimeout(() => { list.style.display = 'none' }, 150))
}

// ---------------------------------------------------------------------------
// Event slug autocomplete
// ---------------------------------------------------------------------------

function attachEventAutocomplete(
  input: HTMLInputElement,
  getCache: () => { slug: string; type: string; display_name: string }[]
): void {
  const list = document.createElement('ul')
  list.className = 'conv-autocomplete'
  list.style.display = 'none'
  input.parentElement!.style.position = 'relative'
  input.insertAdjacentElement('afterend', list)

  const update = () => {
    const val = input.value.toLowerCase()
    const events = getCache().filter(e => e.type === 'event')
    const matches = events.filter(e =>
      e.slug.includes(val) || e.display_name.toLowerCase().includes(val)
    ).slice(0, 8)
    list.innerHTML = ''
    if (matches.length === 0) { list.style.display = 'none'; return }
    for (const ev of matches) {
      const li = document.createElement('li')
      li.textContent = ev.slug
      li.title = ev.display_name
      li.onmousedown = (e) => {
        e.preventDefault()
        input.value = ev.slug
        input.dispatchEvent(new Event('input'))
        list.style.display = 'none'
      }
      list.appendChild(li)
    }
    list.style.display = 'block'
  }

  input.addEventListener('input', update)
  input.addEventListener('focus', update)
  input.addEventListener('blur', () => setTimeout(() => { list.style.display = 'none' }, 150))
}

// ---------------------------------------------------------------------------
// ConversationEditor class
// ---------------------------------------------------------------------------

export class ConversationEditor {
  private el: HTMLElement
  private data: ConvData = emptyConvData()
  private entitySlug: string = ''
  private _saveTimer: ReturnType<typeof setTimeout> | null = null
  private _entityCache: { slug: string; type: string; display_name: string }[] = []
  private _registeredVoices: Set<string> = new Set()

  constructor(container: HTMLElement) {
    this.el = container
    this.el.className = 'conv-editor'
  }

  getEl(): HTMLElement { return this.el }

  async load(entitySlug: string): Promise<void> {
    this.entitySlug = entitySlug
    const state = getState()
    if (!state.projectSlug) return

    const [detail, cache, voiceList] = await Promise.all([
      api.getEntity(state.projectSlug, entitySlug),
      api.listEntities(state.projectSlug),
      api.listVoices(state.projectSlug).catch(() => ({ voices: [] as string[] })),
    ])
    this._entityCache = cache
    this._registeredVoices = new Set(voiceList.voices)
    this.data = parseConvBody(detail.body)
    this._render()
  }

  private _save(): void {
    if (this._saveTimer) clearTimeout(this._saveTimer)
    this._saveTimer = setTimeout(async () => {
      const state = getState()
      if (!state.projectSlug) return
      try {
        await api.updateEntity(state.projectSlug, this.entitySlug, {
          body: serializeConvBody(this.data)
        })
      } catch (e) {
        console.error('[terrrence] conversation save failed', e)
      }
    }, 800)
  }

  // -------------------------------------------------------------------------
  // Top-level render
  // -------------------------------------------------------------------------

  private _render(): void {
    this.el.innerHTML = ''

    const scroll = document.createElement('div')
    scroll.className = 'conv-scroll'

    const greetTitle = document.createElement('div')
    greetTitle.className = 'conv-col-title'
    greetTitle.textContent = 'Greetings'
    scroll.appendChild(greetTitle)
    scroll.appendChild(this._renderGreetings())

    const menuTitle = document.createElement('div')
    menuTitle.className = 'conv-col-title conv-col-title--menu'
    menuTitle.textContent = 'Menu'
    scroll.appendChild(menuTitle)
    scroll.appendChild(this._renderMenu(this.data.menu, null))

    this.el.appendChild(scroll)
  }

  // -------------------------------------------------------------------------
  // Greetings
  // -------------------------------------------------------------------------

  private _renderGreetings(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'conv-section'

    for (let i = 0; i < this.data.greetings.length; i++) {
      wrap.appendChild(this._renderGreeting(i))
    }

    const addBtn = document.createElement('button')
    addBtn.className = 'conv-add-btn'
    addBtn.textContent = '+ Add greeting'
    addBtn.onclick = () => {
      const ids = allIds(this.data)
      const g: ConvGreeting = {
        id: deriveConvId('greet', ids),
        prerequisite: null,
        lines: [],
      }
      this.data.greetings.push(g)
      this._save()
      this._render()
    }
    wrap.appendChild(addBtn)
    return wrap
  }

  private _renderGreeting(idx: number): HTMLElement {
    const g = this.data.greetings[idx]
    const card = document.createElement('div')
    card.className = 'conv-card'

    // Header row
    const hdr = document.createElement('div')
    hdr.className = 'conv-card-hdr'

    const idBadge = document.createElement('span')
    idBadge.className = 'conv-id-badge'
    idBadge.textContent = g.id
    hdr.appendChild(idBadge)

    const actions = document.createElement('div')
    actions.className = 'conv-card-actions'
    if (idx > 0) {
      const up = this._iconBtn('↑', 'Move up', () => {
        ;[this.data.greetings[idx - 1], this.data.greetings[idx]] =
          [this.data.greetings[idx], this.data.greetings[idx - 1]]
        this._save(); this._render()
      })
      actions.appendChild(up)
    }
    if (idx < this.data.greetings.length - 1) {
      const dn = this._iconBtn('↓', 'Move down', () => {
        ;[this.data.greetings[idx], this.data.greetings[idx + 1]] =
          [this.data.greetings[idx + 1], this.data.greetings[idx]]
        this._save(); this._render()
      })
      actions.appendChild(dn)
    }
    const del = this._iconBtn('x', 'Delete greeting', () => {
      this.data.greetings.splice(idx, 1)
      this._save(); this._render()
    }, true)
    actions.appendChild(del)
    hdr.appendChild(actions)
    card.appendChild(hdr)

    // Prerequisite
    card.appendChild(this._prereqRow(
      g.prerequisite,
      (v) => { g.prerequisite = v || null; this._save() }
    ))

    // Lines
    card.appendChild(this._renderLines(g.lines, () => { this._save(); this._render() }, g.id))

    return card
  }

  // -------------------------------------------------------------------------
  // Menu tree
  // -------------------------------------------------------------------------

  private _renderMenu(opts: ConvOption[], parentOpt: ConvOption | null): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = parentOpt ? 'conv-submenu' : 'conv-section'

    for (let i = 0; i < opts.length; i++) {
      wrap.appendChild(this._renderOption(opts, i, parentOpt))
    }

    const addBtn = document.createElement('button')
    addBtn.className = parentOpt ? 'conv-add-btn conv-add-btn--sub' : 'conv-add-btn'
    addBtn.textContent = '+ Add option'
    addBtn.onclick = () => {
      const ids = allIds(this.data)
      const base = parentOpt ? parentOpt.id + '_sub' : 'opt'
      const o: ConvOption = {
        id: deriveConvId(base, ids),
        label: '',
        prerequisite: null,
        triggers: null,
        lines: [],
        response_menu: [],
      }
      opts.push(o)
      this._save(); this._render()
    }
    wrap.appendChild(addBtn)
    return wrap
  }

  private _renderOption(opts: ConvOption[], idx: number, _parent: ConvOption | null): HTMLElement {
    const o = opts[idx]
    const card = document.createElement('div')
    card.className = 'conv-card'

    // Header
    const hdr = document.createElement('div')
    hdr.className = 'conv-card-hdr'

    const idBadge = document.createElement('span')
    idBadge.className = 'conv-id-badge'
    idBadge.textContent = o.id
    hdr.appendChild(idBadge)

    const actions = document.createElement('div')
    actions.className = 'conv-card-actions'
    if (idx > 0) {
      actions.appendChild(this._iconBtn('↑', 'Move up', () => {
        ;[opts[idx - 1], opts[idx]] = [opts[idx], opts[idx - 1]]
        this._save(); this._render()
      }))
    }
    if (idx < opts.length - 1) {
      actions.appendChild(this._iconBtn('↓', 'Move down', () => {
        ;[opts[idx], opts[idx + 1]] = [opts[idx + 1], opts[idx]]
        this._save(); this._render()
      }))
    }
    actions.appendChild(this._iconBtn('x', 'Delete option', () => {
      opts.splice(idx, 1)
      this._save(); this._render()
    }, true))
    hdr.appendChild(actions)
    card.appendChild(hdr)

    // Label
    const labelRow = document.createElement('div')
    labelRow.className = 'conv-field-row'
    const labelLbl = document.createElement('label')
    labelLbl.className = 'conv-field-label'
    labelLbl.textContent = 'Label'
    const labelInput = document.createElement('input')
    labelInput.type = 'text'
    labelInput.className = 'conv-input'
    labelInput.value = o.label
    labelInput.placeholder = 'Player-facing menu text'
    labelInput.oninput = () => { o.label = labelInput.value; this._save() }
    labelRow.appendChild(labelLbl)
    labelRow.appendChild(labelInput)
    card.appendChild(labelRow)

    // Prerequisite + Triggers
    card.appendChild(this._prereqRow(o.prerequisite, (v) => { o.prerequisite = v || null; this._save() }))
    card.appendChild(this._triggersRow(o.triggers, (v) => { o.triggers = v || null; this._save() }))

    // Lines
    card.appendChild(this._renderLines(o.lines, () => { this._save(); this._render() }, o.id))

    // Response menu (recursive, collapsible)
    const subToggle = document.createElement('button')
    subToggle.className = 'conv-sub-toggle'
    const subCount = o.response_menu.length
    subToggle.textContent = subCount > 0
      ? `Response menu (${subCount}) -`
      : `Response menu +`
    const subWrap = document.createElement('div')
    subWrap.className = 'conv-sub-wrap'
    subWrap.style.display = subCount > 0 ? 'block' : 'none'

    subToggle.onclick = () => {
      const open = subWrap.style.display === 'none'
      subWrap.style.display = open ? 'block' : 'none'
      subToggle.textContent = open
        ? `Response menu (${o.response_menu.length}) -`
        : `Response menu (${o.response_menu.length}) +`
    }

    subWrap.appendChild(this._renderMenu(o.response_menu, o))
    card.appendChild(subToggle)
    card.appendChild(subWrap)

    return card
  }

  // -------------------------------------------------------------------------
  // Lines editor
  // -------------------------------------------------------------------------

  private _renderLines(lines: ConvLine[], onStructure: () => void, containerId: string = ''): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'conv-lines'

    for (let i = 0; i < lines.length; i++) {
      wrap.appendChild(this._renderLine(lines, i, onStructure, containerId))
    }

    const addBtn = document.createElement('button')
    addBtn.className = 'conv-add-btn conv-add-btn--line'
    addBtn.textContent = '+ Line'
    addBtn.onclick = () => {
      lines.push({ speaker: '', text: '', audio: null })
      onStructure()
    }
    wrap.appendChild(addBtn)
    return wrap
  }

  private _renderLine(lines: ConvLine[], idx: number, onStructure: () => void, containerId: string = ''): HTMLElement {
    const line = lines[idx]
    const row = document.createElement('div')
    row.className = 'conv-line-row'

    // Speaker input
    const speakerWrap = document.createElement('div')
    speakerWrap.className = 'conv-speaker-wrap'
    const speakerInput = document.createElement('input')
    speakerInput.type = 'text'
    speakerInput.className = 'conv-input conv-speaker-input'
    speakerInput.value = line.speaker
    speakerInput.placeholder = '##Character##'
    speakerInput.title = 'Speaker - must be a valid ##Character## token'

    const speakerErr = document.createElement('span')
    speakerErr.className = 'conv-field-err'
    speakerErr.style.display = 'none'
    speakerErr.textContent = '?'
    speakerErr.title = 'Unknown character'

    const validateSpeaker = () => {
      const v = speakerInput.value.trim()
      const valid = v === '' || speakerValid(v, this._entityCache)
      speakerErr.style.display = valid ? 'none' : 'inline'
      if (valid && v !== line.speaker) {
        line.speaker = v
        this._save()
        _updateTtsBtn()
      }
    }
    speakerInput.oninput = validateSpeaker
    speakerInput.onblur = validateSpeaker

    speakerWrap.appendChild(speakerInput)
    speakerWrap.appendChild(speakerErr)
    row.appendChild(speakerWrap)
    attachSpeakerAutocomplete(speakerInput, () => this._entityCache)

    // Text input
    const textInput = document.createElement('textarea')
    textInput.className = 'conv-input conv-line-text'
    textInput.value = line.text
    textInput.placeholder = 'Dialogue text...'
    textInput.rows = 2
    textInput.oninput = () => {
      line.text = textInput.value
      this._save()
      _updateTtsBtn()
    }
    row.appendChild(textInput)

    // Audio slot - play button (if audio exists) + generate button + progress
    const audioSlot = document.createElement('div')
    audioSlot.className = 'conv-audio-slot'

    // Play button (only shown when audio asset exists)
    let audioEl: HTMLAudioElement | null = null
    const playBtn = document.createElement('button')
    playBtn.className = 'conv-tts-btn conv-play-btn'
    playBtn.textContent = '▶'
    playBtn.title = 'Play voice clip'
    playBtn.style.display = line.audio !== null ? 'inline-block' : 'none'
    playBtn.onclick = () => {
      const state = getState()
      if (!state.projectSlug || line.audio === null) return
      if (audioEl) { audioEl.pause(); audioEl = null; playBtn.textContent = '▶'; return }
      audioEl = new Audio(api.assetFileUrl(state.projectSlug, line.audio))
      audioEl.play()
      playBtn.textContent = '■'
      audioEl.onended = () => { playBtn.textContent = '▶'; audioEl = null }
      audioEl.onerror = () => { playBtn.textContent = '▶'; audioEl = null }
    }
    audioSlot.appendChild(playBtn)

    // Progress bar (shown during generation)
    const progressWrap = document.createElement('div')
    progressWrap.className = 'conv-progress-wrap'
    progressWrap.style.display = 'none'
    const progressTrack = document.createElement('div')
    progressTrack.className = 'conv-progress-bar-track'
    const progressBar = document.createElement('div')
    progressBar.className = 'conv-progress-bar'
    const progressLabel = document.createElement('div')
    progressLabel.className = 'conv-progress-label'
    progressTrack.appendChild(progressBar)
    progressWrap.appendChild(progressTrack)
    progressWrap.appendChild(progressLabel)
    audioSlot.appendChild(progressWrap)

    // Generate button
    const ttsBtn = document.createElement('button')
    ttsBtn.className = 'conv-tts-btn'
    ttsBtn.textContent = line.audio !== null ? '⟳' : '⊕'
    ttsBtn.title = line.audio !== null ? 'Re-generate voice' : 'Generate voice'

    const _updateTtsBtn = () => {
      const spk = speakerInput.value.trim()
      const txt = textInput.value.trim()
      const spkValid = speakerValid(spk, this._entityCache)
      const charEntry = this._entityCache.find(e => e.type === 'character' && spk === `##${e.display_name}##`)
      const hasVoice = charEntry ? this._registeredVoices.has(charEntry.slug) : false
      if (!txt && !spk) {
        ttsBtn.disabled = true
        ttsBtn.title = 'Speaker and text required'
      } else if (!txt) {
        ttsBtn.disabled = true
        ttsBtn.title = 'Text required'
      } else if (!spk || !spkValid) {
        ttsBtn.disabled = true
        ttsBtn.title = 'Valid speaker (##Character##) required'
      } else if (!hasVoice) {
        ttsBtn.disabled = true
        ttsBtn.title = 'No voice registered for this character - record one in the character preview pane'
      } else {
        ttsBtn.disabled = false
        ttsBtn.title = line.audio !== null ? 'Re-generate voice' : 'Generate voice'
      }
    }
    _updateTtsBtn()

    let _progressTimer: ReturnType<typeof setInterval> | null = null

    const _startProgress = (txt: string) => {
      const estimate = _TtsTimer.estimate(txt.length)
      const start = Date.now()
      progressWrap.style.display = 'flex'
      ttsBtn.style.display = 'none'
      playBtn.style.display = 'none'
      const tick = () => {
        const elapsed = (Date.now() - start) / 1000
        const pct = estimate > 0 ? Math.min(95, (elapsed / estimate) * 100) : 50
        progressBar.style.width = `${pct}%`
        const rem = Math.max(0, Math.ceil(estimate - elapsed))
        progressLabel.textContent = rem > 0 ? `~${rem}s` : '...'
      }
      tick()
      _progressTimer = setInterval(tick, 250)
    }

    const _stopProgress = () => {
      if (_progressTimer) { clearInterval(_progressTimer); _progressTimer = null }
      progressWrap.style.display = 'none'
      progressBar.style.width = '0%'
      ttsBtn.style.display = 'inline-block'
    }

    ttsBtn.onclick = async () => {
      const state = getState()
      if (!state.projectSlug || !containerId) return
      const spk = speakerInput.value.trim()
      const txt = textInput.value.trim()
      const charEntry = this._entityCache.find(e =>
        e.type === 'character' && spk === `##${e.display_name}##`
      )
      if (!charEntry || !txt) return
      ttsBtn.disabled = true
      _startProgress(txt)
      const t0 = Date.now()
      try {
        const result = await api.generateVoice(state.projectSlug, this.entitySlug, {
          line_id: containerId,
          line_index: idx,
          text: txt,
          speaker_slug: charEntry.slug,
        })
        _TtsTimer.record(txt.length, (Date.now() - t0) / 1000)
        line.audio = result.asset_id
        _stopProgress()
        ttsBtn.textContent = '⟳'
        ttsBtn.title = 'Re-generate voice'
        ttsBtn.disabled = false
        playBtn.style.display = 'inline-block'
        enhBtn.style.display = 'inline-block'
      } catch (e: any) {
        _stopProgress()
        ttsBtn.textContent = line.audio !== null ? '⟳' : '⊕'
        ttsBtn.title = `TTS failed: ${e?.message ?? e}`
        ttsBtn.disabled = false
        playBtn.style.display = line.audio !== null ? 'inline-block' : 'none'
        console.error('[terrrence] TTS error', e)
      }
    }

    audioSlot.appendChild(ttsBtn)

    // Record button - saves raw WAV directly as line audio
    const recBtn = document.createElement('button')
    recBtn.className = 'conv-tts-btn conv-rec-btn'
    recBtn.textContent = '🎙'
    recBtn.title = 'Record line'

    const recStopBtn = document.createElement('button')
    recStopBtn.className = 'conv-tts-btn conv-rec-stop-btn'
    recStopBtn.textContent = '⏹'
    recStopBtn.title = 'Stop recording'
    recStopBtn.style.display = 'none'

    let _stopLineRec: (() => Promise<Blob>) | null = null

    recBtn.onclick = async () => {
      try {
        const rec = await startRecording()
        _stopLineRec = rec.stop
        recBtn.style.display = 'none'
        recStopBtn.style.display = 'inline-block'
      } catch (e: any) {
        recBtn.title = `Mic error: ${e?.message ?? e}`
      }
    }

    recStopBtn.onclick = async () => {
      if (!_stopLineRec) return
      recStopBtn.style.display = 'none'
      recBtn.style.display = 'inline-block'
      recBtn.disabled = true
      recBtn.textContent = '⏳'
      const blob = await _stopLineRec()
      _stopLineRec = null
      const state = getState()
      if (!state.projectSlug || !containerId) { recBtn.disabled = false; recBtn.textContent = '🎙'; return }
      try {
        const wavBuf = await blobToWav(blob)
        const result = await api.recordLine(state.projectSlug, this.entitySlug, containerId, idx, wavBuf)
        line.audio = result.asset_id
        recBtn.textContent = '🎙'
        recBtn.title = 'Re-record line'
        recBtn.disabled = false
        playBtn.style.display = 'inline-block'
        enhBtn.style.display = 'inline-block'
      } catch (e: any) {
        recBtn.textContent = '🎙'
        recBtn.title = `Save failed: ${e?.message ?? e}`
        recBtn.disabled = false
      }
    }

    audioSlot.appendChild(recBtn)
    audioSlot.appendChild(recStopBtn)

    // Enhance button - denoise current line audio via DeepFilterNet
    const enhBtn = document.createElement('button')
    enhBtn.className = 'conv-tts-btn conv-enh-btn'
    enhBtn.textContent = '✨'
    enhBtn.title = 'Enhance (denoise)'
    enhBtn.style.display = line.audio !== null ? 'inline-block' : 'none'

    enhBtn.onclick = async () => {
      if (line.audio === null) return
      const state = getState()
      if (!state.projectSlug || !containerId) return
      enhBtn.disabled = true
      enhBtn.textContent = '⏳'
      try {
        const result = await api.enhanceLine(state.projectSlug, this.entitySlug, containerId, idx, line.audio)
        line.audio = result.asset_id
        enhBtn.textContent = '✨'
        enhBtn.title = 'Re-enhance'
        enhBtn.disabled = false
        const audio = row.querySelector('audio.conv-line-player') as HTMLAudioElement | null
        if (audio && state.projectSlug) { audio.src = api.assetFileUrl(state.projectSlug, result.asset_id); audio.load() }
      } catch (e: any) {
        enhBtn.textContent = '✨'
        enhBtn.title = `Enhance failed: ${e?.message ?? e}`
        enhBtn.disabled = false
      }
    }

    audioSlot.appendChild(enhBtn)
    row.appendChild(audioSlot)

    // Line actions
    const acts = document.createElement('div')
    acts.className = 'conv-line-acts'
    if (idx > 0) {
      acts.appendChild(this._iconBtn('↑', 'Move up', () => {
        ;[lines[idx - 1], lines[idx]] = [lines[idx], lines[idx - 1]]
        onStructure()
      }))
    }
    if (idx < lines.length - 1) {
      acts.appendChild(this._iconBtn('↓', 'Move down', () => {
        ;[lines[idx], lines[idx + 1]] = [lines[idx + 1], lines[idx]]
        onStructure()
      }))
    }
    acts.appendChild(this._iconBtn('x', 'Delete line', () => {
      lines.splice(idx, 1)
      onStructure()
    }, true))
    row.appendChild(acts)

    return row
  }

  // -------------------------------------------------------------------------
  // Shared field builders
  // -------------------------------------------------------------------------

  private _prereqRow(value: string | null, onChange: (v: string) => void): HTMLElement {
    const row = document.createElement('div')
    row.className = 'conv-field-row'
    const lbl = document.createElement('label')
    lbl.className = 'conv-field-label'
    lbl.textContent = 'Prereq'
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'conv-input conv-event-input'
    input.value = value ?? ''
    input.placeholder = 'event_slug or blank'
    input.oninput = () => onChange(input.value.trim())
    row.appendChild(lbl)
    row.appendChild(input)
    attachEventAutocomplete(input, () => this._entityCache)
    return row
  }

  private _triggersRow(value: string | null, onChange: (v: string) => void): HTMLElement {
    const row = document.createElement('div')
    row.className = 'conv-field-row'
    const lbl = document.createElement('label')
    lbl.className = 'conv-field-label'
    lbl.textContent = 'Triggers'
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'conv-input conv-event-input'
    input.value = value ?? ''
    input.placeholder = 'event_slug or blank'
    input.oninput = () => onChange(input.value.trim())
    row.appendChild(lbl)
    row.appendChild(input)
    attachEventAutocomplete(input, () => this._entityCache)
    return row
  }

  private _iconBtn(label: string, title: string, handler: () => void, danger = false): HTMLElement {
    const btn = document.createElement('button')
    btn.className = 'conv-icon-btn' + (danger ? ' conv-icon-btn--danger' : '')
    btn.textContent = label
    btn.title = title
    btn.onclick = (e) => { e.stopPropagation(); handler() }
    return btn
  }
}
