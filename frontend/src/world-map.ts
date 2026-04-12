import { api, Entity } from './api'
import { getState } from './state'

// --- Types ---

interface EdgePoint { edge: 'top' | 'right' | 'bottom' | 'left'; t: number }

interface ConnectionHalf {
  id: string          // slugA__slugB (alpha sorted)
  to: string          // slug of the other location
  from_edge: EdgePoint
  to_edge: EdgePoint
}

interface LocationEntry {
  entity: Entity
  map_x: number | null
  map_y: number | null
  thumbUrl: string | null
  connections: ConnectionHalf[]
}

// Connection as rendered (both halves resolved)
interface Connection {
  id: string
  fromSlug: string
  toSlug: string
  from_edge: EdgePoint
  to_edge: EdgePoint
}

// --- Public entry point ---

export async function showWorldMap(entities: Entity[]): Promise<void> {
  const state = getState()
  if (!state.projectSlug) return
  const project = state.projectSlug

  const locations = entities.filter(e => e.type === 'location')

  const entries: LocationEntry[] = await Promise.all(
    locations.map(async (loc): Promise<LocationEntry> => {
      let map_x: number | null = null
      let map_y: number | null = null
      let thumbUrl: string | null = null
      let connections: ConnectionHalf[] = []

      try {
        const detail = await api.getEntity(project, loc.slug)
        const meta = detail.meta ?? {}
        if (typeof meta['map_x'] === 'number') map_x = meta['map_x'] as number
        if (typeof meta['map_y'] === 'number') map_y = meta['map_y'] as number
        if (Array.isArray(meta['connections'])) {
          connections = (meta['connections'] as unknown[]).filter(_isValidHalf) as ConnectionHalf[]
        }
      } catch (_) {}

      try {
        const assets = await api.listEntityAssets(project, loc.slug)
        const img = assets.find(a => a.mime.startsWith('image/'))
        if (img) thumbUrl = api.assetFileUrl(project, img.id)
      } catch (_) {}

      return { entity: loc, map_x, map_y, thumbUrl, connections }
    })
  )

  _buildOverlay(project, entries)
}

function _isValidHalf(x: unknown): boolean {
  if (!x || typeof x !== 'object') return false
  const h = x as Record<string, unknown>
  return typeof h['id'] === 'string' && typeof h['to'] === 'string' &&
    _isValidEdge(h['from_edge']) && _isValidEdge(h['to_edge'])
}

function _isValidEdge(x: unknown): boolean {
  if (!x || typeof x !== 'object') return false
  const e = x as Record<string, unknown>
  return ['top','right','bottom','left'].includes(e['edge'] as string) && typeof e['t'] === 'number'
}

// --- Connection ID ---

function _connId(slugA: string, slugB: string): string {
  return [slugA, slugB].sort().join('__')
}

// --- Overlay builder ---

function _buildOverlay(project: string, entries: LocationEntry[]): void {
  document.getElementById('world-map-overlay')?.remove()

  const overlay = document.createElement('div')
  overlay.id = 'world-map-overlay'
  overlay.className = 'wm-overlay'
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove() }

  const container = document.createElement('div')
  container.className = 'wm-container'
  overlay.appendChild(container)

  // Tray
  const tray = document.createElement('div')
  tray.className = 'wm-tray'
  const trayTitle = document.createElement('div')
  trayTitle.className = 'wm-tray-title'
  trayTitle.textContent = 'Unplaced'
  tray.appendChild(trayTitle)
  const trayList = document.createElement('div')
  trayList.className = 'wm-tray-list'
  tray.appendChild(trayList)

  // Canvas
  const canvas = document.createElement('div')
  canvas.className = 'wm-canvas'

  const grid = document.createElement('div')
  grid.className = 'wm-grid'
  canvas.appendChild(grid)

  // SVG layer for connection lines
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'wm-svg')
  svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible;'
  canvas.appendChild(svg)

  const closeBtn = document.createElement('button')
  closeBtn.className = 'wm-close'
  closeBtn.textContent = 'x'
  closeBtn.title = 'Close map'
  closeBtn.onclick = () => overlay.remove()
  canvas.appendChild(closeBtn)

  container.appendChild(tray)
  container.appendChild(canvas)
  document.body.appendChild(overlay)

  // Build entry map for fast lookup
  const entryMap = new Map<string, LocationEntry>()
  for (const e of entries) entryMap.set(e.entity.slug, e)

  // Place cards
  for (const entry of entries) {
    const card = _makeCard(entry)
    if (entry.map_x !== null && entry.map_y !== null) {
      _placeOnCanvas(canvas, trayList, svg, card, entry, entryMap, project, entry.map_x, entry.map_y)
    } else {
      _placeInTray(trayList, canvas, svg, card, entry, entryMap, project)
    }
  }

  // Draw existing connections (deduplicated by id)
  const seen = new Set<string>()
  for (const entry of entries) {
    for (const half of entry.connections) {
      if (seen.has(half.id)) continue
      seen.add(half.id)
      const other = entryMap.get(half.to)
      if (!other) continue
      const conn: Connection = {
        id: half.id,
        fromSlug: entry.entity.slug,
        toSlug: half.to,
        from_edge: half.from_edge,
        to_edge: half.to_edge,
      }
      _drawConnection(svg, canvas, conn, entryMap, project)
    }
  }
}

// --- Card factory ---

function _makeCard(entry: LocationEntry): HTMLElement {
  const card = document.createElement('div')
  card.className = 'wm-card'
  card.dataset.slug = entry.entity.slug

  if (entry.thumbUrl) {
    const img = document.createElement('img')
    img.src = entry.thumbUrl
    img.className = 'wm-card-img'
    img.draggable = false
    card.appendChild(img)
  }

  const label = document.createElement('div')
  label.className = 'wm-card-label'
  label.textContent = entry.entity.display_name
  card.appendChild(label)

  // Connection zone indicator (outer 34%, pointer-events handled in JS)
  const zone = document.createElement('div')
  zone.className = 'wm-card-connzone'
  card.appendChild(zone)

  return card
}

// --- Placement helpers ---

function _placeInTray(
  trayList: HTMLElement,
  canvas: HTMLElement,
  svg: SVGSVGElement,
  card: HTMLElement,
  entry: LocationEntry,
  entryMap: Map<string, LocationEntry>,
  project: string
): void {
  card.classList.add('wm-card--tray')
  trayList.appendChild(card)
  _attachInteraction(card, canvas, trayList, svg, entry, entryMap, project)
}

function _placeOnCanvas(
  canvas: HTMLElement,
  trayList: HTMLElement,
  svg: SVGSVGElement,
  card: HTMLElement,
  entry: LocationEntry,
  entryMap: Map<string, LocationEntry>,
  project: string,
  nx: number,
  ny: number
): void {
  card.classList.remove('wm-card--tray')
  card.classList.add('wm-card--placed')
  canvas.appendChild(card)
  _setCardPos(card, canvas, nx, ny)
  _attachInteraction(card, canvas, trayList, svg, entry, entryMap, project)
}

function _setCardPos(card: HTMLElement, canvas: HTMLElement, nx: number, ny: number): void {
  const r = canvas.getBoundingClientRect()
  card.style.left = `${nx * r.width}px`
  card.style.top  = `${ny * r.height}px`
}

// --- Edge point geometry ---

function _edgePointPx(card: HTMLElement, _canvas: HTMLElement, ep: EdgePoint): { x: number; y: number } {
  const cl = parseFloat(card.style.left) || 0
  const ct = parseFloat(card.style.top)  || 0
  const cw = card.offsetWidth
  const ch = card.offsetHeight
  // card is positioned by top-left corner (transform: translate(-50%,-50%) applied via CSS)
  // so actual top-left on canvas is (cl - cw/2, ct - ch/2)
  const x0 = cl - cw / 2
  const y0 = ct - ch / 2
  switch (ep.edge) {
    case 'top':    return { x: x0 + ep.t * cw,  y: y0 }
    case 'bottom': return { x: x0 + ep.t * cw,  y: y0 + ch }
    case 'left':   return { x: x0,              y: y0 + ep.t * ch }
    case 'right':  return { x: x0 + cw,         y: y0 + ep.t * ch }
  }
}

// Given cursor position relative to canvas, and a card's rect relative to canvas,
// return the nearest EdgePoint on that card
function _nearestEdge(cursorCanvasX: number, cursorCanvasY: number, card: HTMLElement): EdgePoint {
  const cl = parseFloat(card.style.left) || 0
  const ct = parseFloat(card.style.top)  || 0
  const cw = card.offsetWidth
  const ch = card.offsetHeight
  const x0 = cl - cw / 2
  const y0 = ct - ch / 2

  // Clamp cursor to card bounding box edges
  const cx = Math.max(x0, Math.min(x0 + cw, cursorCanvasX))
  const cy = Math.max(y0, Math.min(y0 + ch, cursorCanvasY))

  // Distance to each edge
  const dTop    = Math.abs(cy - y0)
  const dBottom = Math.abs(cy - (y0 + ch))
  const dLeft   = Math.abs(cx - x0)
  const dRight  = Math.abs(cx - (x0 + cw))

  const min = Math.min(dTop, dBottom, dLeft, dRight)
  if (min === dTop)    return { edge: 'top',    t: Math.max(0, Math.min(1, (cursorCanvasX - x0) / cw)) }
  if (min === dBottom) return { edge: 'bottom', t: Math.max(0, Math.min(1, (cursorCanvasX - x0) / cw)) }
  if (min === dLeft)   return { edge: 'left',   t: Math.max(0, Math.min(1, (cursorCanvasY - y0) / ch)) }
  return                      { edge: 'right',  t: Math.max(0, Math.min(1, (cursorCanvasY - y0) / ch)) }
}

// Is cursor in the outer 34% connection zone of the card?
function _inConnZone(e: MouseEvent, card: HTMLElement): boolean {
  const rect = card.getBoundingClientRect()
  const rx = (e.clientX - rect.left) / rect.width
  const ry = (e.clientY - rect.top)  / rect.height
  const margin = 0.17  // 34% total border zone = 17% each side
  return rx < margin || rx > 1 - margin || ry < margin || ry > 1 - margin
}

// --- Connection drawing ---

function _drawConnection(
  svg: SVGSVGElement,
  canvas: HTMLElement,
  conn: Connection,
  entryMap: Map<string, LocationEntry>,
  project: string
): SVGLineElement | null {
  const fromEntry = entryMap.get(conn.fromSlug)
  const toEntry   = entryMap.get(conn.toSlug)
  if (!fromEntry || !toEntry) return null

  const fromCard = canvas.querySelector<HTMLElement>(`[data-slug="${conn.fromSlug}"]`)
  const toCard   = canvas.querySelector<HTMLElement>(`[data-slug="${conn.toSlug}"]`)
  if (!fromCard || !toCard) return null

  const p1 = _edgePointPx(fromCard, canvas, conn.from_edge)
  const p2 = _edgePointPx(toCard,   canvas, conn.to_edge)

  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
  line.setAttribute('x1', String(p1.x))
  line.setAttribute('y1', String(p1.y))
  line.setAttribute('x2', String(p2.x))
  line.setAttribute('y2', String(p2.y))
  line.setAttribute('stroke', '#7ec8e3')
  line.setAttribute('stroke-width', '2')
  line.setAttribute('stroke-opacity', '0.7')
  line.dataset.connId = conn.id
  line.style.pointerEvents = 'stroke'
  line.style.cursor = 'pointer'

  // Wider invisible hit target
  const hitLine = document.createElementNS('http://www.w3.org/2000/svg', 'line')
  hitLine.setAttribute('x1', String(p1.x))
  hitLine.setAttribute('y1', String(p1.y))
  hitLine.setAttribute('x2', String(p2.x))
  hitLine.setAttribute('y2', String(p2.y))
  hitLine.setAttribute('stroke', 'transparent')
  hitLine.setAttribute('stroke-width', '12')
  hitLine.dataset.connId = conn.id
  hitLine.style.pointerEvents = 'stroke'
  hitLine.style.cursor = 'pointer'

  hitLine.addEventListener('contextmenu', async (ev) => {
    ev.preventDefault()
    ev.stopPropagation()
    if (!confirm(`Delete connection between "${fromEntry.entity.display_name}" and "${toEntry.entity.display_name}"?`)) return
    // Remove both halves from entries
    fromEntry.connections = fromEntry.connections.filter(h => h.id !== conn.id)
    toEntry.connections   = toEntry.connections.filter(h => h.id !== conn.id)
    // Remove from SVG
    line.remove()
    hitLine.remove()
    // Persist both halves
    try {
      await api.updateEntityMeta(project, conn.fromSlug, { connections: fromEntry.connections })
      await api.updateEntityMeta(project, conn.toSlug,   { connections: toEntry.connections })
    } catch (err) {
      console.error('[terrrence] world-map: failed to delete connection', err)
    }
  })

  svg.appendChild(line)
  svg.appendChild(hitLine)
  return line
}

function _redrawConnections(
  svg: SVGSVGElement,
  canvas: HTMLElement,
  entryMap: Map<string, LocationEntry>,
  project: string,
  entries: LocationEntry[]
): void {
  // Remove all existing lines
  svg.querySelectorAll('line').forEach(l => l.remove())
  // Redraw
  const seen = new Set<string>()
  for (const entry of entries) {
    for (const half of entry.connections) {
      if (seen.has(half.id)) continue
      seen.add(half.id)
      const other = entryMap.get(half.to)
      if (!other) continue
      _drawConnection(svg, canvas, {
        id: half.id,
        fromSlug: entry.entity.slug,
        toSlug: half.to,
        from_edge: half.from_edge,
        to_edge: half.to_edge,
      }, entryMap, project)
    }
  }
}

// --- Interaction (drag + connection mode) ---

function _attachInteraction(
  card: HTMLElement,
  canvas: HTMLElement,
  trayList: HTMLElement,
  svg: SVGSVGElement,
  entry: LocationEntry,
  entryMap: Map<string, LocationEntry>,
  project: string
): void {
  const entries = Array.from(entryMap.values())

  card.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()

    if (_inConnZone(e, card) && card.classList.contains('wm-card--placed')) {
      _startConnection(e, card, canvas, svg, entry, entryMap, project, entries)
    } else {
      _startDrag(e, card, canvas, trayList, svg, entry, entryMap, project, entries)
    }
  })
}

// --- Drag ---

function _startDrag(
  e: MouseEvent,
  card: HTMLElement,
  canvas: HTMLElement,
  trayList: HTMLElement,
  svg: SVGSVGElement,
  entry: LocationEntry,
  entryMap: Map<string, LocationEntry>,
  project: string,
  entries: LocationEntry[]
): void {
  const rect = card.getBoundingClientRect()
  const offsetX = e.clientX - rect.left
  const offsetY = e.clientY - rect.top

  const ghost = card.cloneNode(true) as HTMLElement
  ghost.className = 'wm-card wm-card--ghost'
  ghost.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;pointer-events:none;`
  document.body.appendChild(ghost)

  const onMove = (ev: MouseEvent) => {
    ghost.style.left = `${ev.clientX - offsetX}px`
    ghost.style.top  = `${ev.clientY - offsetY}px`
  }

  const onUp = async (ev: MouseEvent) => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    ghost.remove()

    const canvasRect = canvas.getBoundingClientRect()
    const overCanvas = ev.clientX >= canvasRect.left && ev.clientX <= canvasRect.right &&
                       ev.clientY >= canvasRect.top  && ev.clientY <= canvasRect.bottom

    if (overCanvas) {
      const cardW = card.offsetWidth  || 80
      const cardH = card.offsetHeight || 60
      // Preserve the offset so the card stays under the same grip point
      const relX = ev.clientX - offsetX - canvasRect.left + cardW / 2
      const relY = ev.clientY - offsetY - canvasRect.top  + cardH / 2
      const nx = Math.max(0, Math.min(1, relX / canvasRect.width))
      const ny = Math.max(0, Math.min(1, relY / canvasRect.height))

      card.classList.remove('wm-card--tray')
      card.classList.add('wm-card--placed')
      canvas.appendChild(card)
      card.style.left = `${relX}px`
      card.style.top  = `${relY}px`
      entry.map_x = nx
      entry.map_y = ny

      _redrawConnections(svg, canvas, entryMap, project, entries)

      try {
        await api.updateEntityMeta(project, entry.entity.slug, { map_x: nx, map_y: ny })
      } catch (err) {
        console.error('[terrrence] world-map: failed to save position', err)
      }
    } else if (card.classList.contains('wm-card--placed')) {
      card.classList.remove('wm-card--placed')
      card.classList.add('wm-card--tray')
      card.style.left = ''
      card.style.top  = ''
      trayList.appendChild(card)
      entry.map_x = null
      entry.map_y = null

      _redrawConnections(svg, canvas, entryMap, project, entries)

      try {
        await api.updateEntityMeta(project, entry.entity.slug, { map_x: '', map_y: '' })
      } catch (err) {
        console.error('[terrrence] world-map: failed to clear position', err)
      }
    }
  }

  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

// --- Connection drawing interaction ---

function _startConnection(
  e: MouseEvent,
  fromCard: HTMLElement,
  canvas: HTMLElement,
  svg: SVGSVGElement,
  fromEntry: LocationEntry,
  entryMap: Map<string, LocationEntry>,
  project: string,
  entries: LocationEntry[]
): void {
  const canvasRect = canvas.getBoundingClientRect()

  // Determine starting edge point on fromCard
  const fromCanvasX = e.clientX - canvasRect.left
  const fromCanvasY = e.clientY - canvasRect.top
  const fromEdge = _nearestEdge(fromCanvasX, fromCanvasY, fromCard)
  const startPx = _edgePointPx(fromCard, canvas, fromEdge)

  // Rubber-band line
  const rubberLine = document.createElementNS('http://www.w3.org/2000/svg', 'line')
  rubberLine.setAttribute('x1', String(startPx.x))
  rubberLine.setAttribute('y1', String(startPx.y))
  rubberLine.setAttribute('x2', String(startPx.x))
  rubberLine.setAttribute('y2', String(startPx.y))
  rubberLine.setAttribute('stroke', '#f4a261')
  rubberLine.setAttribute('stroke-width', '2')
  rubberLine.setAttribute('stroke-dasharray', '6 3')
  rubberLine.style.pointerEvents = 'none'
  svg.appendChild(rubberLine)

  // Highlight fromCard
  fromCard.classList.add('wm-card--connecting')

  let snapTarget: HTMLElement | null = null
  let snapEdge: EdgePoint | null = null

  const onMove = (ev: MouseEvent) => {
    const cx = ev.clientX - canvasRect.left
    const cy = ev.clientY - canvasRect.top
    rubberLine.setAttribute('x2', String(cx))
    rubberLine.setAttribute('y2', String(cy))

    // Snap to nearest placed card that isn't fromCard
    snapTarget = null
    snapEdge = null
    let bestDist = 40  // snap threshold px

    for (const entry of entries) {
      if (entry.entity.slug === fromEntry.entity.slug) continue
      const card = canvas.querySelector<HTMLElement>(`[data-slug="${entry.entity.slug}"]`)
      if (!card || !card.classList.contains('wm-card--placed')) continue

      const cl = parseFloat(card.style.left) || 0
      const ct = parseFloat(card.style.top)  || 0
      const cw = card.offsetWidth
      const ch = card.offsetHeight
      const x0 = cl - cw / 2
      const y0 = ct - ch / 2

      // Check if cursor is within or near card
      const nearX = cx >= x0 - bestDist && cx <= x0 + cw + bestDist
      const nearY = cy >= y0 - bestDist && cy <= y0 + ch + bestDist
      if (!nearX || !nearY) continue

      const ep = _nearestEdge(cx, cy, card)
      const epPx = _edgePointPx(card, canvas, ep)
      const dist = Math.hypot(cx - epPx.x, cy - epPx.y)
      if (dist < bestDist) {
        bestDist = dist
        snapTarget = card
        snapEdge = ep
      }
    }

    if (snapTarget && snapEdge) {
      const snapPx = _edgePointPx(snapTarget, canvas, snapEdge)
      rubberLine.setAttribute('x2', String(snapPx.x))
      rubberLine.setAttribute('y2', String(snapPx.y))
      rubberLine.setAttribute('stroke', '#7ec8e3')
      snapTarget.classList.add('wm-card--snap')
    } else {
      rubberLine.setAttribute('stroke', '#f4a261')
      canvas.querySelectorAll('.wm-card--snap').forEach(c => c.classList.remove('wm-card--snap'))
    }
  }

  const onUp = async (ev: MouseEvent) => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    rubberLine.remove()
    fromCard.classList.remove('wm-card--connecting')
    canvas.querySelectorAll('.wm-card--snap').forEach(c => c.classList.remove('wm-card--snap'))

    if (!snapTarget || !snapEdge) return

    const toSlug = snapTarget.dataset.slug!
    const toEntry = entryMap.get(toSlug)
    if (!toEntry) return

    const connId = _connId(fromEntry.entity.slug, toSlug)

    // Avoid duplicate
    if (fromEntry.connections.some(h => h.id === connId)) return

    const canvasRect2 = canvas.getBoundingClientRect()
    const cx = ev.clientX - canvasRect2.left
    const cy = ev.clientY - canvasRect2.top
    const toEdge = _nearestEdge(cx, cy, snapTarget)

    const fromHalf: ConnectionHalf = { id: connId, to: toSlug,                  from_edge: fromEdge, to_edge: toEdge }
    const toHalf: ConnectionHalf   = { id: connId, to: fromEntry.entity.slug,    from_edge: toEdge,   to_edge: fromEdge }

    fromEntry.connections.push(fromHalf)
    toEntry.connections.push(toHalf)

    _drawConnection(svg, canvas, {
      id: connId,
      fromSlug: fromEntry.entity.slug,
      toSlug,
      from_edge: fromEdge,
      to_edge: toEdge,
    }, entryMap, project)

    try {
      await api.updateEntityMeta(project, fromEntry.entity.slug, { connections: fromEntry.connections })
      await api.updateEntityMeta(project, toSlug, { connections: toEntry.connections })
    } catch (err) {
      console.error('[terrrence] world-map: failed to save connection', err)
    }
  }

  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}
