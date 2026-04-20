// Conversation editor - recursive line tree replacing old greetings/menu split.

import { api } from './api'
import { blobToWav, startRecording } from './audio-utils'
import { getState } from './state'
import {
  ConvData, ConvLine,
  allIds, deriveConvId, emptyConvData, emptyLine, parseConvBody, serializeConvBody
} from './conversation-types'

// ---------------------------------------------------------------------------
// TTS timing tracker
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
    if (this._samples.length === 0) return chars * 0.12
    const rate = this._samples.reduce((s, x) => s + x.secs / Math.max(1, x.chars), 0) / this._samples.length
    return Math.max(2, chars * rate)
  }
}()

// ---------------------------------------------------------------------------
// Speaker validation + autocomplete
// ---------------------------------------------------------------------------

const SPEAKER_RE = /^##[^#]+##$/

function speakerValid(val: string, cache: { slug: string; type: string; display_name: string }[]): boolean {
  if (!SPEAKER_RE.test(val)) return false
  const inner = val.slice(2, -2).trim()
  return cache.some(e => e.type === 'character' && e.display_name === inner)
}

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
    const query = val.startsWith('##') ? val.slice(2) : val
    const matches = getCache().filter(e => e.type === 'character' &&
      e.display_name.toLowerCase().includes(query.toLowerCase())).slice(0, 8)
    list.innerHTML = ''
    if (!matches.length || val === `##${query}##`) { list.style.display = 'none'; return }
    for (const c of matches) {
      const li = document.createElement('li')
      li.textContent = `##${c.display_name}##`
      li.onmousedown = (e) => { e.preventDefault(); input.value = `##${c.display_name}##`; input.dispatchEvent(new Event('input')); list.style.display = 'none' }
      list.appendChild(li)
    }
    list.style.display = 'block'
  }
  input.addEventListener('input', update)
  input.addEventListener('focus', update)
  input.addEventListener('blur', () => setTimeout(() => { list.style.display = 'none' }, 150))
}

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
    const matches = getCache().filter(e => e.type === 'event' &&
      (e.slug.includes(val) || e.display_name.toLowerCase().includes(val))).slice(0, 8)
    list.innerHTML = ''
    if (!matches.length) { list.style.display = 'none'; return }
    for (const ev of matches) {
      const li = document.createElement('li')
      li.textContent = ev.slug; li.title = ev.display_name
      li.onmousedown = (e) => { e.preventDefault(); input.value = ev.slug; input.dispatchEvent(new Event('input')); list.style.display = 'none' }
      list.appendChild(li)
    }
    list.style.display = 'block'
  }
  input.addEventListener('input', update)
  input.addEventListener('focus', update)
  input.addEventListener('blur', () => setTimeout(() => { list.style.display = 'none' }, 150))
}

// ---------------------------------------------------------------------------
// ConversationEditor
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
        await api.updateEntity(state.projectSlug, this.entitySlug, { body: serializeConvBody(this.data) })
      } catch (e) { console.error('[terrrence] conversation save failed', e) }
    }, 800)
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  private _render(): void {
    this.el.innerHTML = ''
    const scroll = document.createElement('div')
    scroll.className = 'conv-scroll'
    scroll.appendChild(this._renderLineList(this.data.lines, null, 0))
    this.el.appendChild(scroll)
  }

  private _renderLineList(lines: ConvLine[], parent: ConvLine | null, depth: number): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = depth === 0 ? 'conv-section' : 'conv-submenu'

    for (let i = 0; i < lines.length; i++) {
      wrap.appendChild(this._renderLine(lines, i, parent, depth))
    }

    const addBtn = document.createElement('button')
    addBtn.className = depth === 0 ? 'conv-add-btn' : 'conv-add-btn conv-add-btn--sub'
    addBtn.textContent = depth === 0 ? '+ Add line' : '+ Add response'
    addBtn.onclick = () => {
      const id = deriveConvId(parent ? parent.id + '_r' : 'line', allIds(this.data.lines))
      lines.push(emptyLine(id))
      this._save(); this._render()
    }
    wrap.appendChild(addBtn)
    return wrap
  }

  private _renderLine(lines: ConvLine[], idx: number, _parent: ConvLine | null, depth: number): HTMLElement {
    const line = lines[idx]
    const card = document.createElement('div')
    card.className = 'conv-card'
    if (depth > 0) card.classList.add('conv-card--nested')

    // Header
    const hdr = document.createElement('div')
    hdr.className = 'conv-card-hdr'
    const idBadge = document.createElement('span')
    idBadge.className = 'conv-id-badge'
    idBadge.textContent = line.id
    hdr.appendChild(idBadge)
    const acts = document.createElement('div')
    acts.className = 'conv-card-actions'
    if (idx > 0) acts.appendChild(this._iconBtn('↑', 'Move up', () => { [lines[idx-1], lines[idx]] = [lines[idx], lines[idx-1]]; this._save(); this._render() }))
    if (idx < lines.length - 1) acts.appendChild(this._iconBtn('↓', 'Move down', () => { [lines[idx], lines[idx+1]] = [lines[idx+1], lines[idx]]; this._save(); this._render() }))
    acts.appendChild(this._iconBtn('x', 'Delete', () => { lines.splice(idx, 1); this._save(); this._render() }, true))
    hdr.appendChild(acts)
    card.appendChild(hdr)

    // Speaker
    const speakerWrap = document.createElement('div')
    speakerWrap.className = 'conv-field-row'
    const speakerLbl = document.createElement('label')
    speakerLbl.className = 'conv-field-label'
    speakerLbl.textContent = 'Speaker'
    const speakerInner = document.createElement('div')
    speakerInner.style.position = 'relative'
    speakerInner.style.flex = '1'
    const speakerInput = document.createElement('input')
    speakerInput.type = 'text'
    speakerInput.className = 'conv-input conv-speaker-input'
    speakerInput.value = line.speaker
    speakerInput.placeholder = '##Character##'
    const speakerErr = document.createElement('span')
    speakerErr.className = 'conv-field-err'
    speakerErr.style.display = line.speaker && !speakerValid(line.speaker, this._entityCache) ? 'inline' : 'none'
    speakerErr.textContent = '?'
    speakerErr.title = 'Unknown character'
    speakerInput.oninput = speakerInput.onblur = () => {
      const v = speakerInput.value.trim()
      speakerErr.style.display = (v && !speakerValid(v, this._entityCache)) ? 'inline' : 'none'
      line.speaker = v; this._save()
    }
    speakerInner.appendChild(speakerInput)
    speakerInner.appendChild(speakerErr)
    attachSpeakerAutocomplete(speakerInput, () => this._entityCache)
    speakerWrap.appendChild(speakerLbl)
    speakerWrap.appendChild(speakerInner)
    card.appendChild(speakerWrap)

    // Text
    const textRow = document.createElement('div')
    textRow.className = 'conv-field-row conv-field-row--text'
    const textLbl = document.createElement('label')
    textLbl.className = 'conv-field-label'
    textLbl.textContent = 'Text'
    const textInput = document.createElement('textarea')
    textInput.className = 'conv-input conv-line-text'
    textInput.value = line.text
    textInput.placeholder = 'Dialogue...'
    textInput.rows = 2
    textInput.oninput = () => { line.text = textInput.value; this._save() }
    textRow.appendChild(textLbl)
    textRow.appendChild(textInput)
    card.appendChild(textRow)

    // Prerequisite / Blocker / Triggers
    card.appendChild(this._eventFieldRow('Prereq', line.prerequisite, v => { line.prerequisite = v || null; this._save() }))
    card.appendChild(this._eventFieldRow('Blocker', line.blocker, v => { line.blocker = v || null; this._save() }))
    card.appendChild(this._eventFieldRow('Triggers', line.triggers, v => { line.triggers = v || null; this._save() }))

    // Audio slot
    card.appendChild(this._renderAudioSlot(line))

    // Next lines (recursive)
    const nextCount = line.next.length
    const nextToggle = document.createElement('button')
    nextToggle.className = 'conv-sub-toggle'
    nextToggle.textContent = nextCount > 0 ? `Responses (${nextCount}) -` : 'Responses +'
    const nextWrap = document.createElement('div')
    nextWrap.className = 'conv-sub-wrap'
    nextWrap.style.display = nextCount > 0 ? 'block' : 'none'
    nextToggle.onclick = () => {
      const open = nextWrap.style.display === 'none'
      nextWrap.style.display = open ? 'block' : 'none'
      nextToggle.textContent = open ? `Responses (${line.next.length}) -` : `Responses (${line.next.length}) +`
    }
    nextWrap.appendChild(this._renderLineList(line.next, line, depth + 1))
    card.appendChild(nextToggle)
    card.appendChild(nextWrap)

    return card
  }

  private _renderAudioSlot(line: ConvLine): HTMLElement {
    const slot = document.createElement('div')
    slot.className = 'conv-audio-slot'

    // Play button
    let audioEl: HTMLAudioElement | null = null
    const playBtn = document.createElement('button')
    playBtn.className = 'conv-tts-btn conv-play-btn'
    playBtn.textContent = '▶'
    playBtn.title = 'Play'
    playBtn.style.display = line.audio !== null ? 'inline-block' : 'none'
    playBtn.onclick = () => {
      const state = getState()
      if (!state.projectSlug || line.audio === null) return
      if (audioEl) { audioEl.pause(); audioEl = null; playBtn.textContent = '▶'; return }
      audioEl = new Audio(api.assetFileUrl(state.projectSlug, line.audio))
      audioEl.play(); playBtn.textContent = '■'
      audioEl.onended = audioEl.onerror = () => { playBtn.textContent = '▶'; audioEl = null }
    }
    slot.appendChild(playBtn)

    // Progress bar
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
    slot.appendChild(progressWrap)

    // TTS generate button
    const ttsBtn = document.createElement('button')
    ttsBtn.className = 'conv-tts-btn'
    ttsBtn.textContent = line.audio !== null ? '⟳' : '⊕'
    ttsBtn.title = line.audio !== null ? 'Re-generate voice' : 'Generate voice'
    ttsBtn.disabled = true  // enabled after speaker/voice check below

    const _checkTts = () => {
      const spk = line.speaker.trim()
      const txt = line.text.trim()
      const charEntry = this._entityCache.find(e => e.type === 'character' && `##${e.display_name}##` === spk)
      const hasVoice = charEntry ? this._registeredVoices.has(charEntry.slug) : false
      ttsBtn.disabled = !txt || !spk || !speakerValid(spk, this._entityCache) || !hasVoice
      if (!txt || !spk) ttsBtn.title = 'Speaker and text required'
      else if (!speakerValid(spk, this._entityCache)) ttsBtn.title = 'Valid ##Character## required'
      else if (!hasVoice) ttsBtn.title = 'No voice registered for this character'
      else ttsBtn.title = line.audio !== null ? 'Re-generate voice' : 'Generate voice'
    }
    _checkTts()

    let _progressTimer: ReturnType<typeof setInterval> | null = null
    const _startProgress = (txt: string) => {
      const estimate = _TtsTimer.estimate(txt.length)
      const start = Date.now()
      progressWrap.style.display = 'flex'
      ttsBtn.style.display = 'none'; playBtn.style.display = 'none'
      const tick = () => {
        const elapsed = (Date.now() - start) / 1000
        progressBar.style.width = `${Math.min(95, estimate > 0 ? (elapsed/estimate)*100 : 50)}%`
        progressLabel.textContent = Math.max(0, Math.ceil(estimate - elapsed)) > 0 ? `~${Math.ceil(estimate - elapsed)}s` : '...'
      }
      tick(); _progressTimer = setInterval(tick, 250)
    }
    const _stopProgress = () => {
      if (_progressTimer) { clearInterval(_progressTimer); _progressTimer = null }
      progressWrap.style.display = 'none'; progressBar.style.width = '0%'
      ttsBtn.style.display = 'inline-block'
    }

    ttsBtn.onclick = async () => {
      const state = getState()
      if (!state.projectSlug) return
      const charEntry = this._entityCache.find(e => e.type === 'character' && `##${e.display_name}##` === line.speaker.trim())
      if (!charEntry || !line.text.trim()) return
      ttsBtn.disabled = true; _startProgress(line.text)
      const t0 = Date.now()
      try {
        const result = await api.generateVoice(state.projectSlug, this.entitySlug, {
          line_id: line.id, text: line.text.trim(), speaker_slug: charEntry.slug,
        })
        _TtsTimer.record(line.text.length, (Date.now() - t0) / 1000)
        line.audio = result.asset_id
        _stopProgress(); ttsBtn.textContent = '⟳'; ttsBtn.disabled = false
        playBtn.style.display = 'inline-block'; enhBtn.style.display = 'inline-block'
      } catch (e: any) {
        _stopProgress(); ttsBtn.disabled = false
        ttsBtn.title = `TTS failed: ${e?.message ?? e}`
        console.error('[terrrence] TTS error', e)
      }
    }
    slot.appendChild(ttsBtn)

    // Record
    const recBtn = document.createElement('button')
    recBtn.className = 'conv-tts-btn conv-rec-btn'
    recBtn.textContent = '🎙'; recBtn.title = 'Record line'
    const recStopBtn = document.createElement('button')
    recStopBtn.className = 'conv-tts-btn conv-rec-stop-btn'
    recStopBtn.textContent = '⏹'; recStopBtn.title = 'Stop recording'
    recStopBtn.style.display = 'none'
    let _stopLineRec: (() => Promise<Blob>) | null = null

    recBtn.onclick = async () => {
      try {
        const rec = await startRecording()
        _stopLineRec = rec.stop
        recBtn.style.display = 'none'; recStopBtn.style.display = 'inline-block'
      } catch (e: any) { recBtn.title = `Mic error: ${e?.message ?? e}` }
    }
    recStopBtn.onclick = async () => {
      if (!_stopLineRec) return
      recStopBtn.style.display = 'none'; recBtn.style.display = 'inline-block'
      recBtn.disabled = true; recBtn.textContent = '⏳'
      const blob = await _stopLineRec(); _stopLineRec = null
      const state = getState()
      if (!state.projectSlug) { recBtn.disabled = false; recBtn.textContent = '🎙'; return }
      try {
        const wavBuf = await blobToWav(blob)
        const result = await api.recordLine(state.projectSlug, this.entitySlug, line.id, wavBuf)
        line.audio = result.asset_id
        recBtn.textContent = '🎙'; recBtn.disabled = false
        playBtn.style.display = 'inline-block'; enhBtn.style.display = 'inline-block'
      } catch (e: any) { recBtn.textContent = '🎙'; recBtn.title = `Save failed: ${e?.message ?? e}`; recBtn.disabled = false }
    }
    slot.appendChild(recBtn)
    slot.appendChild(recStopBtn)

    // Enhance
    const enhBtn = document.createElement('button')
    enhBtn.className = 'conv-tts-btn conv-enh-btn'
    enhBtn.textContent = '✨'; enhBtn.title = 'Enhance (denoise)'
    enhBtn.style.display = line.audio !== null ? 'inline-block' : 'none'
    enhBtn.onclick = async () => {
      if (line.audio === null) return
      const state = getState()
      if (!state.projectSlug) return
      enhBtn.disabled = true; enhBtn.textContent = '⏳'
      try {
        const result = await api.enhanceLine(state.projectSlug, this.entitySlug, line.id, line.audio)
        line.audio = result.asset_id
        enhBtn.textContent = '✨'; enhBtn.title = 'Re-enhance'; enhBtn.disabled = false
      } catch (e: any) { enhBtn.textContent = '✨'; enhBtn.title = `Enhance failed: ${e?.message ?? e}`; enhBtn.disabled = false }
    }
    slot.appendChild(enhBtn)

    return slot
  }

  // -------------------------------------------------------------------------
  // Shared helpers
  // -------------------------------------------------------------------------

  private _eventFieldRow(label: string, value: string | null, onChange: (v: string) => void): HTMLElement {
    const row = document.createElement('div')
    row.className = 'conv-field-row'
    const lbl = document.createElement('label')
    lbl.className = 'conv-field-label'
    lbl.textContent = label
    const input = document.createElement('input')
    input.type = 'text'; input.className = 'conv-input conv-event-input'
    input.value = value ?? ''; input.placeholder = 'event_slug or blank'
    input.oninput = () => onChange(input.value.trim())
    row.appendChild(lbl); row.appendChild(input)
    attachEventAutocomplete(input, () => this._entityCache)
    return row
  }

  private _iconBtn(label: string, title: string, handler: () => void, danger = false): HTMLElement {
    const btn = document.createElement('button')
    btn.className = 'conv-icon-btn' + (danger ? ' conv-icon-btn--danger' : '')
    btn.textContent = label; btn.title = title
    btn.onclick = (e) => { e.stopPropagation(); handler() }
    return btn
  }
}
