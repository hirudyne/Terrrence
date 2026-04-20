// Scene preview - renders a location scene with characters, items, spots, and
// a world-state-driven conversation overlay.
//
// Lifecycle:
//   const sp = new ScenePreview(containerEl)
//   sp.load(projectSlug, locationSlug)   // call when location changes
//   sp.destroy()                          // call when pane closes

import { api, SceneData, SceneCharacter, SceneItem, SceneSpot } from './api'
import {
  WorldState, EventEntity, initialState,
  lineVisible, spotBlocked, fireEvent,
} from './world-state'
import { ConvLine, ConvData, parseConvBody } from './conversation-types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RuntimeChar {
  data: SceneCharacter
  currentSpot: string | null
}

interface RuntimeItem {
  data: SceneItem
  currentSpot: string | null
}

interface ActiveConversation {
  charSlug: string
  convSlug: string
  convData: ConvData
  currentLines: ConvLine[]
  history: ConvLine[]
}

// ---------------------------------------------------------------------------
// ScenePreview
// ---------------------------------------------------------------------------

export class ScenePreview {
  private container: HTMLElement
  private canvas: HTMLElement
  private overlay: HTMLElement
  private controlBar: HTMLElement
  private sceneData: SceneData | null = null
  private worldState: WorldState | null = null
  private projectSlug: string | null = null
  private locationSlug: string | null = null
  private activeConv: ActiveConversation | null = null
  private charRuntime: Map<string, RuntimeChar> = new Map()
  private itemRuntime: Map<string, RuntimeItem> = new Map()
  private _pollTimer: ReturnType<typeof setInterval> | null = null
  private _destroyed = false

  constructor(container: HTMLElement) {
    this.container = container
    this.container.className = 'scene-preview'
    this.container.innerHTML = ''

    this.controlBar = document.createElement('div')
    this.controlBar.className = 'scene-control-bar'
    this.container.appendChild(this.controlBar)

    this.canvas = document.createElement('div')
    this.canvas.className = 'scene-canvas'
    this.container.appendChild(this.canvas)

    this.overlay = document.createElement('div')
    this.overlay.className = 'scene-conv-overlay hidden'
    this.container.appendChild(this.overlay)
  }

  async load(projectSlug: string, locationSlug: string) {
    if (this._destroyed) return
    this.projectSlug = projectSlug
    this.locationSlug = locationSlug
    this.canvas.innerHTML = '<div class="scene-loading">Loading...</div>'
    this.overlay.classList.add('hidden')
    this._stopPoll()

    try {
      this.sceneData = await api.getSceneData(projectSlug)
    } catch {
      this.canvas.innerHTML = '<div class="scene-loading">Failed to load scene data.</div>'
      return
    }
    if (this._destroyed) return

    if (!this.worldState) this._resetWorldState()
    else this._initRuntime()

    this._render()
    this._startPoll()
  }

  private _initRuntime() {
    const sd = this.sceneData!
    const ws = this.worldState

    this.charRuntime.clear()
    for (const ch of sd.characters) {
      const startSpot = this._defaultSpotForChar(ch.slug)
      const currentSpot = ws ? (ws.characterPositions[ch.slug] ?? startSpot) : startSpot
      this.charRuntime.set(ch.slug, { data: ch, currentSpot })
    }

    this.itemRuntime.clear()
    for (const it of sd.items) {
      this.itemRuntime.set(it.slug, { data: it, currentSpot: this._defaultSpotForItem(it.slug) })
    }
  }

  private _defaultSpotForChar(charSlug: string): string | null {
    const sd = this.sceneData!
    const ch = sd.characters.find(c => c.slug === charSlug)
    if (!ch) return null
    const sl = ch.meta.start_location as { location?: string; spot?: string } | undefined
    if (!sl || sl.location !== this.locationSlug) return null
    return sl.spot ?? null
  }

  private _defaultSpotForItem(itemSlug: string): string | null {
    const sd = this.sceneData!
    const it = sd.items.find(i => i.slug === itemSlug)
    if (!it) return null
    const sl = it.meta.start_location as { location?: string; spot?: string } | undefined
    if (!sl || sl.location !== this.locationSlug) return null
    return sl.spot ?? null
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  private _render() {
    if (this._destroyed) return
    const sd = this.sceneData!
    const loc = sd.locations.find(l => l.slug === this.locationSlug)
    if (!loc) {
      this.canvas.innerHTML = '<div class="scene-loading">Location not found.</div>'
      return
    }

    this.canvas.innerHTML = ''

    // Background
    const bg = document.createElement('div')
    if (loc.scene_asset) {
      bg.className = 'scene-bg'
      bg.style.backgroundImage = `url(${api.assetFileUrl(this.projectSlug!, loc.scene_asset.id)})`
    } else {
      bg.className = 'scene-bg scene-bg-empty'
      bg.textContent = loc.display_name
    }
    this.canvas.appendChild(bg)

    const spots = sd.spots.filter(s => s.parent_slug === this.locationSlug)
    for (const spot of spots) this._renderSpot(spot)

    for (const [, rt] of this.charRuntime) {
      if (rt.currentSpot && spots.find(s => s.slug === rt.currentSpot)) {
        this._renderCharacter(rt, spots)
      }
    }

    for (const [, rt] of this.itemRuntime) {
      if (rt.currentSpot && spots.find(s => s.slug === rt.currentSpot)) {
        this._renderItem(rt, spots)
      }
    }

    this._renderControlBar()
  }

  private _spotPos(spot: SceneSpot): { x: number; y: number } | null {
    const x = spot.meta.spot_x as number | undefined
    const y = spot.meta.spot_y as number | undefined
    if (x === undefined || x === null || y === undefined || y === null) return null
    return { x, y }
  }

  private _renderSpot(spot: SceneSpot) {
    const pos = this._spotPos(spot)
    if (!pos) return  // unplaced - not shown in scene
    const blocked = this.worldState
      ? spotBlocked(spot.slug, this.worldState.firedEvents, this.sceneData!.events as EventEntity[])
      : false
    const { x, y } = pos
    const hot = !!(spot.meta.hot)

    const el = document.createElement('div')
    el.className = 'scene-spot' + (blocked ? ' blocked' : '') + (hot ? ' hot' : ' cold')
    el.style.left = `${x * 100}%`
    el.style.top = `${y * 100}%`
    el.title = spot.display_name
    if (!blocked) el.addEventListener('click', () => this._onSpotClick(spot))
    this.canvas.appendChild(el)
  }

  private _renderCharacter(rt: RuntimeChar, spots: SceneSpot[]) {
    const spot = spots.find(s => s.slug === rt.currentSpot)
    if (!spot) return
    const pos = this._spotPos(spot)
    if (!pos) return
    const { x, y } = pos

    const el = document.createElement('div')
    el.className = 'scene-char-sprite'
    el.style.left = `${x * 100}%`
    el.style.top = `${y * 100}%`

    if (rt.data.sprite_asset) {
      const img = document.createElement('img')
      img.src = api.assetFileUrl(this.projectSlug!, rt.data.sprite_asset.id)
      img.alt = rt.data.display_name
      el.appendChild(img)
    } else {
      el.classList.add('scene-char-placeholder')
      el.textContent = rt.data.display_name.slice(0, 2).toUpperCase()
    }

    const label = document.createElement('div')
    label.className = 'scene-sprite-label'
    label.textContent = rt.data.display_name
    el.appendChild(label)
    this.canvas.appendChild(el)
  }

  private _renderItem(rt: RuntimeItem, spots: SceneSpot[]) {
    const spot = spots.find(s => s.slug === rt.currentSpot)
    if (!spot) return
    const pos = this._spotPos(spot)
    if (!pos) return
    const { x, y } = pos

    const el = document.createElement('div')
    el.className = 'scene-item-sprite'
    el.style.left = `${x * 100}%`
    el.style.top = `${y * 100}%`

    if (rt.data.first_asset) {
      const img = document.createElement('img')
      img.src = api.assetFileUrl(this.projectSlug!, rt.data.first_asset.id)
      img.alt = rt.data.display_name
      el.appendChild(img)
    } else {
      el.classList.add('scene-item-placeholder')
      el.textContent = rt.data.display_name.slice(0, 2).toUpperCase()
    }

    const label = document.createElement('div')
    label.className = 'scene-sprite-label'
    label.textContent = rt.data.display_name
    el.appendChild(label)
    this.canvas.appendChild(el)
  }

  private _renderControlBar() {
    this.controlBar.innerHTML = ''
    const locName = document.createElement('span')
    locName.className = 'scene-ctrl-locname'
    const loc = this.sceneData?.locations.find(l => l.slug === this.locationSlug)
    locName.textContent = loc?.display_name ?? this.locationSlug ?? ''
    this.controlBar.appendChild(locName)

    const spacer = document.createElement('span')
    spacer.style.flex = '1'
    this.controlBar.appendChild(spacer)

    const resetBtn = document.createElement('button')
    resetBtn.className = 'scene-ctrl-btn'
    resetBtn.textContent = 'Reset'
    resetBtn.title = 'Reset world state to initial'
    resetBtn.addEventListener('click', () => { this._resetWorldState(); this._render() })
    this.controlBar.appendChild(resetBtn)
  }

  // ---------------------------------------------------------------------------
  // Interaction
  // ---------------------------------------------------------------------------

  private async _onSpotClick(spot: SceneSpot) {
    if (this._destroyed) return
    const convSlug = spot.meta.conversation_slug as string | undefined
    if (convSlug) {
      await this._startConversation(convSlug, spot)
      return
    }
    const connId = spot.meta.connection_id as string | undefined
    if (connId) this._followConnection(connId)
  }

  private async _startConversation(convSlug: string, spot: SceneSpot) {
    if (this._destroyed) return
    let convData: ConvData
    try {
      const detail = await api.getEntity(this.projectSlug!, convSlug)
      convData = parseConvBody(detail.body)
    } catch {
      return
    }
    if (this._destroyed) return

    // Find which character is at this spot (if any)
    let charSlug = ''
    for (const [slug, rt] of this.charRuntime) {
      if (rt.currentSpot === spot.slug) { charSlug = slug; break }
    }

    this.activeConv = { charSlug, convSlug, convData, currentLines: convData.lines, history: [] }
    this._renderConversation()
  }

  private _followConnection(connId: string) {
    const sd = this.sceneData!
    const loc = sd.locations.find(l => l.slug === this.locationSlug)
    if (!loc) return
    const connections = (loc.meta.connections as Array<{ id: string; to: string }> | undefined) ?? []
    const conn = connections.find(c => c.id === connId)
    if (conn) this.load(this.projectSlug!, conn.to)
  }

  // ---------------------------------------------------------------------------
  // Conversation rendering
  // ---------------------------------------------------------------------------

  private _renderConversation() {
    const conv = this.activeConv
    if (!conv) { this.overlay.classList.add('hidden'); return }

    this.overlay.classList.remove('hidden')
    this.overlay.innerHTML = ''

    const box = document.createElement('div')
    box.className = 'scene-conv-box'
    this.overlay.appendChild(box)

    // History
    for (const line of conv.history) {
      const el = document.createElement('div')
      el.className = 'scene-conv-line history'
      el.innerHTML = `<span class="scene-conv-speaker">${this._speakerLabel(line.speaker)}</span><span class="scene-conv-text">${line.text}</span>`
      box.appendChild(el)
    }

    const firedEvents = this.worldState?.firedEvents ?? []
    const visible = conv.currentLines.filter(l => lineVisible(l.prerequisite, l.blocker, firedEvents))

    if (visible.length === 0) {
      const endEl = document.createElement('div')
      endEl.className = 'scene-conv-end'
      endEl.textContent = '[end]'
      box.appendChild(endEl)
      const closeBtn = document.createElement('button')
      closeBtn.className = 'scene-conv-close'
      closeBtn.textContent = 'Close'
      closeBtn.addEventListener('click', () => this._endConversation())
      box.appendChild(closeBtn)
      return
    }

    if (visible.length === 1) {
      const line = visible[0]
      const lineEl = document.createElement('div')
      lineEl.className = 'scene-conv-line'
      lineEl.innerHTML = `<span class="scene-conv-speaker">${this._speakerLabel(line.speaker)}</span><span class="scene-conv-text">${line.text}</span>`
      box.appendChild(lineEl)
      if (line.audio !== null) this._playAudio(line.audio)
      const nextBtn = document.createElement('button')
      nextBtn.className = 'scene-conv-choice'
      nextBtn.textContent = line.next.length ? 'Continue' : 'Done'
      nextBtn.addEventListener('click', () => this._advanceLine(line))
      box.appendChild(nextBtn)
    } else {
      const prompt = document.createElement('div')
      prompt.className = 'scene-conv-prompt'
      prompt.textContent = 'Choose:'
      box.appendChild(prompt)
      for (const line of visible) {
        const btn = document.createElement('button')
        btn.className = 'scene-conv-choice'
        btn.textContent = line.text
        btn.addEventListener('click', () => this._advanceLine(line))
        box.appendChild(btn)
      }
    }
  }

  private _advanceLine(line: ConvLine) {
    const conv = this.activeConv
    if (!conv) return
    conv.history.push(line)

    if (line.triggers && this.sceneData) {
      const allEvents = this.sceneData.events as EventEntity[]
      const ws = this.worldState!
      const newWs = fireEvent(line.triggers, allEvents, ws, { type: 'LineSaid', lineId: line.id })
      if (newWs) {
        this.worldState = newWs
        for (const [slug, rt] of this.charRuntime) {
          if (this.worldState.characterPositions[slug] !== undefined) {
            rt.currentSpot = this.worldState.characterPositions[slug]
          }
        }
      }
    }

    if (line.next.length === 0) {
      this._endConversation()
    } else {
      conv.currentLines = line.next
      this._renderConversation()
    }
  }

  private _endConversation() {
    this.activeConv = null
    this.overlay.classList.add('hidden')
    this._render()
  }

  private _speakerLabel(token: string): string {
    return token.replace(/^##|##$/g, '').replace(/^@@|@@$/g, '').replace(/^%%|%%$/g, '')
  }

  private _playAudio(assetId: number) {
    try { new Audio(api.assetFileUrl(this.projectSlug!, assetId)).play().catch(() => {}) } catch {}
  }

  // ---------------------------------------------------------------------------
  // World state
  // ---------------------------------------------------------------------------

  private _resetWorldState() {
    const sd = this.sceneData
    const playerChar = (sd?.game?.meta?.player_character as string | null) ?? null
    this.worldState = initialState(playerChar)
    this._initRuntime()
  }

  // ---------------------------------------------------------------------------
  // Poll
  // ---------------------------------------------------------------------------

  private _startPoll() {
    this._pollTimer = setInterval(async () => {
      if (this._destroyed || !this.projectSlug || !this.locationSlug || this.activeConv) return
      try {
        this.sceneData = await api.getSceneData(this.projectSlug)
        this._render()
      } catch {}
    }, 5000)
  }

  private _stopPoll() {
    if (this._pollTimer !== null) { clearInterval(this._pollTimer); this._pollTimer = null }
  }

  destroy() {
    this._destroyed = true
    this._stopPoll()
    this.container.innerHTML = ''
  }
}
