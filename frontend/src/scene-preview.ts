// Scene preview - renders a location scene with characters, items, spots, and
// a world-state-driven conversation overlay. Supports Play/Pause/Reset.

import { api, SceneData, SceneCharacter, SceneItem, SceneSpot } from './api'
import {
  WorldState, EventEntity, initialState,
  lineVisible, spotBlocked, fireEvent,
} from './world-state'
import { ConvLine, ConvData, parseConvBody } from './conversation-types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WALK_SPEED_PX_PER_S = 200          // at canvas native width; scales with canvas size
const MIN_WALK_DIST_FRACTION = 0.02      // 2% of canvas width - minimum move distance
const SPOT_PROXIMITY_FRACTION = 0.05     // 5% of canvas width - "close enough" to a spot
const WALK_FRAMES_PER_CYCLE = 8
const DEPTH_SCALE_TOP = 0.7              // sprite scale at y=0
const DEPTH_SCALE_BOT = 1.0             // sprite scale at y=1

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PlayMode = 'stopped' | 'playing' | 'paused'
type Facing = 'front' | 'left' | 'right' | 'back'

interface Pos { x: number; y: number }  // normalised 0-1

interface RuntimeChar {
  data: SceneCharacter
  currentSpot: string | null   // slug (for non-PC or when at rest)
  pos: Pos | null              // live position during walk or after walk
  facing: Facing
  spriteEl: HTMLElement | null
  frameUrls: Record<string, string[]>  // facing -> ordered frame data-URLs
}

interface RuntimeItem {
  data: SceneItem
  currentSpot: string | null
}

interface WalkAnimation {
  charSlug: string
  from: Pos
  to: Pos
  facing: Facing
  durationMs: number
  startMs: number
  totalFrames: number          // total animation frames (multiple of 8 for clean loop)
  fps: number
  onArrival: () => void
}

interface ActiveConversation {
  charSlug: string
  convSlug: string
  convData: ConvData
  currentLines: ConvLine[]
  history: ConvLine[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inferFacing(dx: number, dy: number): Facing {
  const adx = Math.abs(dx), ady = Math.abs(dy)
  if (adx > ady) return dx > 0 ? 'right' : 'left'
  return dy > 0 ? 'front' : 'back'
}

function bestAvailableFacing(preferred: Facing, available: string[]): Facing | null {
  const fallbacks: Record<Facing, Facing[]> = {
    left:  ['left', 'right', 'front', 'back'],
    right: ['right', 'left', 'front', 'back'],
    front: ['front', 'left', 'right', 'back'],
    back:  ['back', 'left', 'right', 'front'],
  }
  for (const f of fallbacks[preferred]) {
    if (available.includes(f)) return f as Facing
  }
  return null
}

function depthScale(y: number): number {
  return DEPTH_SCALE_TOP + (DEPTH_SCALE_BOT - DEPTH_SCALE_TOP) * y
}

function dist(a: Pos, b: Pos): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2)
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

  private playMode: PlayMode = 'stopped'
  private activeConv: ActiveConversation | null = null
  private walkAnim: WalkAnimation | null = null
  private _rafId: number | null = null
  private _pausedFrameIndex: number = 0

  private charRuntime: Map<string, RuntimeChar> = new Map()
  private itemRuntime: Map<string, RuntimeItem> = new Map()
  private _pollTimer: ReturnType<typeof setInterval> | null = null
  private _destroyed = false

  // Cached sprite elements keyed by char slug (persist across _renderScene calls)
  private _spriteEls: Map<string, HTMLElement> = new Map()

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

  // ---------------------------------------------------------------------------
  // Load
  // ---------------------------------------------------------------------------

  async load(projectSlug: string, locationSlug: string) {
    if (this._destroyed) return
    this.projectSlug = projectSlug
    this.locationSlug = locationSlug
    this._cancelWalk()
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

    if (!this.worldState) this._initWorldState()
    this._initRuntime()
    this._renderScene()
    this._renderControlBar()
    this._startPoll()
  }

  // ---------------------------------------------------------------------------
  // World state and runtime init
  // ---------------------------------------------------------------------------

  private _initWorldState() {
    const sd = this.sceneData!
    const playerChar = (sd.game?.meta?.player_character as string | null) ?? null
    this.worldState = initialState(playerChar)
  }

  private _initRuntime() {
    const sd = this.sceneData!
    const ws = this.worldState

    // Only clear cached sprite elements when not mid-walk (walk tick owns its element)
    if (!this.walkAnim) this._spriteEls.clear()
    this.charRuntime.clear()
    for (const ch of sd.characters) {
      const startSpot = this._defaultSpotForChar(ch.slug)
      const currentSpot = ws?.characterPositions[ch.slug] ?? startSpot
      const pos = currentSpot ? this._spotPos(this._spotBySlug(currentSpot)) : null
      // Build frame URL map
      const frameUrls: Record<string, string[]> = {}
      for (const [facing, frames] of Object.entries(ch.walk_frames ?? {})) {
        frameUrls[facing] = frames.map(f => api.assetFileUrl(this.projectSlug!, f.id))
      }
      this.charRuntime.set(ch.slug, {
        data: ch, currentSpot, pos: pos ? { ...pos } : null,
        facing: 'front', spriteEl: null, frameUrls,
      })
    }

    this.itemRuntime.clear()
    for (const it of sd.items) {
      this.itemRuntime.set(it.slug, { data: it, currentSpot: this._defaultSpotForItem(it.slug) })
    }
  }

  private _defaultSpotForChar(charSlug: string): string | null {
    const ch = this.sceneData!.characters.find(c => c.slug === charSlug)
    if (!ch) return null
    const sl = ch.meta.start_location as { location?: string; spot?: string } | undefined
    if (!sl || sl.location !== this.locationSlug) return null
    return sl.spot ?? null
  }

  private _defaultSpotForItem(itemSlug: string): string | null {
    const it = this.sceneData!.items.find(i => i.slug === itemSlug)
    if (!it) return null
    const sl = it.meta.start_location as { location?: string; spot?: string } | undefined
    if (!sl || sl.location !== this.locationSlug) return null
    return sl.spot ?? null
  }

  // ---------------------------------------------------------------------------
  // Scene rendering (background + static sprites + spots)
  // ---------------------------------------------------------------------------

  private _renderScene() {
    if (this._destroyed) return
    const sd = this.sceneData!
    const loc = sd.locations.find(l => l.slug === this.locationSlug)
    if (!loc) {
      this.canvas.innerHTML = '<div class="scene-loading">Location not found.</div>'
      return
    }

    // Detach sprite elements so they survive the innerHTML wipe
    const savedSprites: [string, HTMLElement][] = []
    for (const [slug, el] of this._spriteEls) {
      if (this.canvas.contains(el)) { el.remove(); savedSprites.push([slug, el]) }
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

    // Canvas click for walk (play mode only)
    const pcSlug = this.worldState?.playerCharacter ?? null
    const pcRt = pcSlug ? this.charRuntime.get(pcSlug) : null
    const pcInLocation = !!(pcRt?.pos || (pcRt?.currentSpot && this._spotBySlug(pcRt.currentSpot ?? '')))
    if (this.playMode === 'playing' && pcInLocation) {
      this.canvas.style.cursor = 'crosshair'
      this.canvas.addEventListener('click', this._onCanvasClick)
    } else {
      this.canvas.style.cursor = ''
    }

    // Spots
    const spots = sd.spots.filter(s => s.parent_slug === this.locationSlug)
    for (const spot of spots) this._renderSpot(spot)

    // Items
    for (const [, rt] of this.itemRuntime) {
      if (rt.currentSpot) {
        const spotObj = spots.find(s => s.slug === rt.currentSpot)
        if (spotObj) this._renderItem(rt, spotObj)
      }
    }

    // Re-append previously detached sprites
    for (const [, el] of savedSprites) this.canvas.appendChild(el)

    // Characters (static; walk anim manages its own element via _placeCharSprite)
    for (const [slug, rt] of this.charRuntime) {
      if (this.walkAnim?.charSlug === slug) continue
      const pos = rt.pos ?? (rt.currentSpot ? this._spotPos(this._spotBySlug(rt.currentSpot)) : null)
      if (pos) this._placeCharSprite(slug, rt, pos)
    }
  }

  private _spotBySlug(slug: string): SceneSpot | undefined {
    return this.sceneData?.spots.find(s => s.slug === slug)
  }

  private _spotPos(spot: SceneSpot | undefined): Pos | null {
    if (!spot) return null
    const x = spot.meta.spot_x as number | undefined
    const y = spot.meta.spot_y as number | undefined
    if (x === undefined || x === null || y === undefined || y === null) return null
    return { x, y }
  }

  private _renderSpot(spot: SceneSpot) {
    const pos = this._spotPos(spot)
    if (!pos) return
    const blocked = this.worldState
      ? spotBlocked(spot.slug, this.worldState.firedEvents, this.sceneData!.events as EventEntity[])
      : false
    const hot = !!(spot.meta.hot)

    const el = document.createElement('div')
    el.className = 'scene-spot' + (blocked ? ' blocked' : '') + (hot ? ' hot' : ' cold')
    el.style.left = `${pos.x * 100}%`
    el.style.top = `${pos.y * 100}%`
    el.title = spot.display_name
    if (!blocked) el.addEventListener('click', e => { e.stopPropagation(); this._onSpotClick(spot) })
    this.canvas.appendChild(el)
  }

  private _renderItem(rt: RuntimeItem, spot: SceneSpot) {
    const pos = this._spotPos(spot)
    if (!pos) return
    const el = document.createElement('div')
    el.className = 'scene-item-sprite'
    el.style.left = `${pos.x * 100}%`
    el.style.top = `${pos.y * 100}%`
    const sc = depthScale(pos.y)
    el.style.transform = `translate(-50%, -50%) scale(${sc})`

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

  // ---------------------------------------------------------------------------
  // Sprite placement (shared for static + walk)
  // ---------------------------------------------------------------------------

  private _placeCharSprite(slug: string, rt: RuntimeChar, pos: Pos, frameIndex = 0): HTMLElement {
    let el = this._spriteEls.get(slug)
    const isNew = !el
    if (isNew) {
      el = document.createElement('div')
      el.className = 'scene-char-sprite'
      el.dataset.charSlug = slug
      // Pre-build persistent img and label children - never recreate them
      const img = document.createElement('img')
      img.className = 'scene-char-img'
      img.alt = rt.data.display_name
      el.appendChild(img)
      const ph = document.createElement('div')
      ph.className = 'scene-char-ph'
      el.appendChild(ph)
      const label = document.createElement('div')
      label.className = 'scene-sprite-label'
      label.textContent = rt.data.display_name
      el.appendChild(label)
      this._spriteEls.set(slug, el)
    }
    if (!this.canvas.contains(el!)) this.canvas.appendChild(el!)

    el!.style.left = `${pos.x * 100}%`
    el!.style.top = `${pos.y * 100}%`
    const sc = depthScale(pos.y)
    el!.style.transform = `translate(-50%, -100%) scale(${sc})`

    const frames = rt.frameUrls[rt.facing]
    const hasFrames = frames && frames.length >= WALK_FRAMES_PER_CYCLE
    const img = el!.querySelector<HTMLImageElement>('.scene-char-img')!
    const ph = el!.querySelector<HTMLElement>('.scene-char-ph')!

    if (hasFrames) {
      const newSrc = frames[frameIndex % WALK_FRAMES_PER_CYCLE]
      if (img.src !== newSrc) img.src = newSrc  // only update on actual frame change
      img.style.display = ''
      ph.style.display = 'none'
      el!.classList.remove('scene-char-placeholder')
    } else if (rt.data.sprite_asset) {
      const newSrc = api.assetFileUrl(this.projectSlug!, rt.data.sprite_asset.id)
      if (img.src !== newSrc) img.src = newSrc
      img.style.display = ''
      ph.style.display = 'none'
      el!.classList.remove('scene-char-placeholder')
    } else {
      img.style.display = 'none'
      ph.style.display = ''
      ph.textContent = rt.data.display_name.slice(0, 2).toUpperCase()
      el!.classList.add('scene-char-placeholder')
    }

    return el!
  }

  // ---------------------------------------------------------------------------
  // Control bar
  // ---------------------------------------------------------------------------

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

    // Determine if play is possible
    const pcSlug = this.worldState?.playerCharacter ?? null
    const pcRt = pcSlug ? this.charRuntime.get(pcSlug) : null
    const pcInLocation = !!(pcRt && (pcRt.pos || pcRt.currentSpot))
    const canPlay = pcInLocation

    const playBtn = document.createElement('button')
    playBtn.className = 'scene-ctrl-btn' + (this.playMode === 'playing' ? ' active' : '')
    playBtn.textContent = '▶'
    playBtn.title = 'Play'
    playBtn.disabled = !canPlay || this.playMode === 'playing'
    playBtn.addEventListener('click', () => this._setPlayMode('playing'))
    this.controlBar.appendChild(playBtn)

    const pauseBtn = document.createElement('button')
    pauseBtn.className = 'scene-ctrl-btn' + (this.playMode === 'paused' ? ' active' : '')
    pauseBtn.textContent = '⏸'
    pauseBtn.title = 'Pause'
    pauseBtn.disabled = this.playMode === 'stopped' || this.playMode === 'paused'
    pauseBtn.addEventListener('click', () => this._setPlayMode('paused'))
    this.controlBar.appendChild(pauseBtn)

    const resetBtn = document.createElement('button')
    resetBtn.className = 'scene-ctrl-btn'
    resetBtn.textContent = '↺'
    resetBtn.title = this.playMode !== 'stopped' ? 'Return PC to start' : 'Reset world state'
    resetBtn.addEventListener('click', () => this._onReset())
    this.controlBar.appendChild(resetBtn)
  }

  private _setPlayMode(mode: PlayMode) {
    const prev = this.playMode
    this.playMode = mode

    if (mode === 'paused' && prev === 'playing') {
      // Freeze walk animation mid-frame
      if (this._rafId !== null) {
        cancelAnimationFrame(this._rafId)
        this._rafId = null
      }
      // Record current frame index for resume
      if (this.walkAnim) {
        const elapsed = performance.now() - this.walkAnim.startMs
        this._pausedFrameIndex = Math.floor((elapsed / 1000) * this.walkAnim.fps) % WALK_FRAMES_PER_CYCLE
      }
    }

    if (mode === 'playing' && prev === 'paused') {
      // Resume walk if one was active
      if (this.walkAnim) {
        // Shift startMs so we resume from current position
        const elapsed = (this._pausedFrameIndex / this.walkAnim.fps) * 1000
        this.walkAnim.startMs = performance.now() - elapsed
        this._rafId = requestAnimationFrame(this._walkTick)
      }
    }

    if (mode === 'stopped') {
      this._cancelWalk()
    }

    // Re-render to update canvas click handler and control bar state
    this._renderScene()
    this._renderControlBar()
  }

  private _onReset() {
    this._cancelWalk()
    if (this.playMode !== 'stopped') {
      // In play mode: return PC to start position only
      const pcSlug = this.worldState?.playerCharacter ?? null
      if (pcSlug) {
        const rt = this.charRuntime.get(pcSlug)
        if (rt) {
          rt.currentSpot = this._defaultSpotForChar(pcSlug)
          rt.pos = rt.currentSpot ? this._spotPos(this._spotBySlug(rt.currentSpot ?? '')) : null
          rt.facing = 'front'
        }
      }
    } else {
      // In stopped mode: full world state reset
      this._initWorldState()
      this._initRuntime()
    }
    this._renderScene()
    this._renderControlBar()
  }

  // ---------------------------------------------------------------------------
  // Canvas click -> walk
  // ---------------------------------------------------------------------------

  private _onCanvasClick = (e: MouseEvent) => {
    if (this._destroyed || this.playMode !== 'playing') return
    const rect = this.canvas.getBoundingClientRect()
    const tx = (e.clientX - rect.left) / rect.width
    const ty = (e.clientY - rect.top) / rect.height
    this._walkPcTo({ x: tx, y: ty }, null)
  }

  private _walkPcTo(target: Pos, onArrival: (() => void) | null) {
    const pcSlug = this.worldState?.playerCharacter ?? null
    if (!pcSlug) return
    const rt = this.charRuntime.get(pcSlug)
    if (!rt) return

    // Resolve current PC position
    const fromPos = rt.pos ?? (rt.currentSpot ? this._spotPos(this._spotBySlug(rt.currentSpot ?? '')) : null)
    if (!fromPos) return

    // Minimum distance check (2% of canvas width in normalised coords, accounting for aspect ratio)
    const canvasRect = this.canvas.getBoundingClientRect()
    const aspect = canvasRect.width / (canvasRect.height || 1)
    const dx = (target.x - fromPos.x)
    const dy = (target.y - fromPos.y) * aspect  // rough aspect correction
    const d = Math.sqrt(dx * dx + dy * dy)
    if (d < MIN_WALK_DIST_FRACTION) return

    // Cancel any existing walk
    this._cancelWalk()

    // dy already has aspect correction applied above; use it directly
    const facing = inferFacing(dx, dy)
    const bestFacing = bestAvailableFacing(facing, Object.keys(rt.frameUrls)) ?? facing
    rt.facing = bestFacing

    // Duration proportional to distance; round to clean 8-frame multiple
    const canvasW = canvasRect.width || 800
    const physDist = d * canvasW  // pixels at current canvas size
    const rawDurationMs = (physDist / WALK_SPEED_PX_PER_S) * 1000
    const framesPerSecond = 8  // base FPS for walk
    const rawTotalFrames = Math.max(8, Math.round((rawDurationMs / 1000) * framesPerSecond))
    const totalFrames = Math.ceil(rawTotalFrames / WALK_FRAMES_PER_CYCLE) * WALK_FRAMES_PER_CYCLE
    const durationMs = (totalFrames / framesPerSecond) * 1000

    this.walkAnim = {
      charSlug: pcSlug,
      from: { ...fromPos },
      to: { ...target },
      facing: bestFacing,
      durationMs,
      startMs: performance.now(),
      totalFrames,
      fps: framesPerSecond,
      onArrival: onArrival ?? (() => {}),
    }

    this._rafId = requestAnimationFrame(this._walkTick)
  }

  private _walkTick = (now: number) => {
    if (this._destroyed || !this.walkAnim || this.playMode === 'paused') return
    const anim = this.walkAnim
    const rt = this.charRuntime.get(anim.charSlug)
    if (!rt) { this._cancelWalk(); return }

    const elapsed = now - anim.startMs
    const t = Math.min(elapsed / anim.durationMs, 1)

    // Smoothstep ease in/out: 3t^2 - 2t^3 (C1-continuous, no discontinuity)
    const eased = t * t * (3 - 2 * t)

    const pos: Pos = {
      x: anim.from.x + (anim.to.x - anim.from.x) * eased,
      y: anim.from.y + (anim.to.y - anim.from.y) * eased,
    }
    rt.pos = pos

    const frameIndex = Math.floor((elapsed / 1000) * anim.fps) % WALK_FRAMES_PER_CYCLE
    this._placeCharSprite(anim.charSlug, rt, pos, frameIndex)

    if (t >= 1) {
      // Arrived
      rt.pos = { ...anim.to }
      rt.currentSpot = null  // PC is now at a free position
      this._placeCharSprite(anim.charSlug, rt, rt.pos, 0)
      const onArrival = anim.onArrival
      this.walkAnim = null
      this._rafId = null
      onArrival()
      return
    }

    this._rafId = requestAnimationFrame(this._walkTick)
  }

  private _cancelWalk() {
    if (this._rafId !== null) { cancelAnimationFrame(this._rafId); this._rafId = null }
    this.walkAnim = null
  }

  // ---------------------------------------------------------------------------
  // Spot interaction
  // ---------------------------------------------------------------------------

  private _onSpotClick(spot: SceneSpot) {
    if (this._destroyed) return
    const blocked = this.worldState
      ? spotBlocked(spot.slug, this.worldState.firedEvents, this.sceneData!.events as EventEntity[])
      : false
    if (blocked) return

    if (this.playMode !== 'playing') {
      // Stopped mode: direct trigger (old behaviour)
      this._triggerSpot(spot)
      return
    }

    // Play mode: check PC proximity first
    const pcSlug = this.worldState?.playerCharacter ?? null
    const pcRt = pcSlug ? this.charRuntime.get(pcSlug) : null
    if (!pcRt) { this._triggerSpot(spot); return }

    const pcPos = pcRt.pos ?? (pcRt.currentSpot ? this._spotPos(this._spotBySlug(pcRt.currentSpot ?? '')) : null)
    const spotPos = this._spotPos(spot)
    if (!spotPos) { this._triggerSpot(spot); return }

    const canvasRect = this.canvas.getBoundingClientRect()
    const aspect = canvasRect.width / (canvasRect.height || 1)
    const threshold = SPOT_PROXIMITY_FRACTION

    if (pcPos && dist({ x: pcPos.x, y: pcPos.y * aspect }, { x: spotPos.x, y: spotPos.y * aspect }) <= threshold) {
      // Close enough - trigger immediately
      this._triggerSpot(spot)
    } else {
      // Walk to spot first, then trigger
      this._walkPcTo(spotPos, () => this._triggerSpot(spot))
    }
  }

  private _triggerSpot(spot: SceneSpot) {
    const convSlug = spot.meta.conversation_slug as string | undefined
    if (convSlug) { this._startConversation(convSlug, spot); return }
    const connId = spot.meta.connection_id as string | undefined
    if (connId) this._followConnection(connId)
  }

  private async _startConversation(convSlug: string, spot: SceneSpot) {
    if (this._destroyed) return
    let convData: ConvData
    try {
      const detail = await api.getEntity(this.projectSlug!, convSlug)
      convData = parseConvBody(detail.body)
    } catch { return }
    if (this._destroyed) return

    // Find NPC at this spot and set their facing toward PC
    let charSlug = ''
    const spotPos = this._spotPos(spot)
    const pcSlug = this.worldState?.playerCharacter ?? null
    const pcRt = pcSlug ? this.charRuntime.get(pcSlug) : null
    const pcPos = pcRt?.pos ?? (pcRt?.currentSpot ? this._spotPos(this._spotBySlug(pcRt.currentSpot ?? '')) : null)

    for (const [slug, rt] of this.charRuntime) {
      if (rt.currentSpot === spot.slug && slug !== pcSlug) {
        charSlug = slug
        // Orient NPC toward PC
        if (spotPos && pcPos) {
          const dx = pcPos.x - spotPos.x
          const dy = pcPos.y - spotPos.y
          const preferred = inferFacing(dx, dy)
          const best = bestAvailableFacing(preferred, Object.keys(rt.frameUrls))
          if (best) {
            rt.facing = best
            const npcEl = this._spriteEls.get(slug)
            if (npcEl && spotPos) this._placeCharSprite(slug, rt, spotPos, 0)
          }
        }
        break
      }
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
  // Conversation
  // ---------------------------------------------------------------------------

  private _renderConversation() {
    const conv = this.activeConv
    if (!conv) { this.overlay.classList.add('hidden'); return }

    this.overlay.classList.remove('hidden')
    this.overlay.innerHTML = ''

    const box = document.createElement('div')
    box.className = 'scene-conv-box'
    this.overlay.appendChild(box)

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
      nextBtn.addEventListener('click', () => { if (this.playMode !== 'paused') this._advanceLine(line) })
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
        btn.disabled = this.playMode === 'paused'
        btn.addEventListener('click', () => { if (this.playMode !== 'paused') this._advanceLine(line) })
        box.appendChild(btn)
      }
    }
  }

  private _advanceLine(line: ConvLine) {
    const conv = this.activeConv
    if (!conv || this.playMode === 'paused') return
    conv.history.push(line)

    if (line.triggers && this.sceneData) {
      const allEvents = this.sceneData.events as EventEntity[]
      const newWs = fireEvent(line.triggers, allEvents, this.worldState!, { type: 'LineSaid', lineId: line.id })
      if (newWs) {
        this.worldState = newWs
        for (const [slug, rt] of this.charRuntime) {
          if (this.worldState.characterPositions[slug] !== undefined) {
            rt.currentSpot = this.worldState.characterPositions[slug]
            rt.pos = this._spotPos(this._spotBySlug(rt.currentSpot ?? ''))
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
    this._renderScene()
  }

  private _speakerLabel(token: string): string {
    return token.replace(/^##|##$/g, '').replace(/^@@|@@$/g, '').replace(/^%%|%%$/g, '')
  }

  private _playAudio(assetId: number) {
    try { new Audio(api.assetFileUrl(this.projectSlug!, assetId)).play().catch(() => {}) } catch {}
  }

  // ---------------------------------------------------------------------------
  // Poll (authoring changes; suspended while walk or conversation active)
  // ---------------------------------------------------------------------------

  private _startPoll() {
    this._pollTimer = setInterval(async () => {
      if (this._destroyed || !this.projectSlug || !this.locationSlug) return
      if (this.walkAnim || this.activeConv) return
      try {
        this.sceneData = await api.getSceneData(this.projectSlug)
        this._renderScene()
        this._renderControlBar()
      } catch {}
    }, 5000)
  }

  private _stopPoll() {
    if (this._pollTimer !== null) { clearInterval(this._pollTimer); this._pollTimer = null }
  }

  // ---------------------------------------------------------------------------
  // Destroy
  // ---------------------------------------------------------------------------

  destroy() {
    this._destroyed = true
    this._cancelWalk()
    this._stopPoll()
    this.canvas.removeEventListener('click', this._onCanvasClick)
    this.container.innerHTML = ''
  }
}
