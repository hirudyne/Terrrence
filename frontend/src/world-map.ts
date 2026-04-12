import { api, Entity } from './api'
import { getState } from './state'

interface LocationEntry {
  entity: Entity
  map_x: number | null
  map_y: number | null
  thumbUrl: string | null
}

export async function showWorldMap(entities: Entity[]): Promise<void> {
  const state = getState()
  if (!state.projectSlug) return
  const project = state.projectSlug

  const locations = entities.filter(e => e.type === 'location')

  // Fetch meta + first image asset for each location in parallel
  const entries: LocationEntry[] = await Promise.all(
    locations.map(async (loc): Promise<LocationEntry> => {
      let map_x: number | null = null
      let map_y: number | null = null
      let thumbUrl: string | null = null

      try {
        const detail = await api.getEntity(project, loc.slug)
        const meta = detail.meta ?? {}
        if (typeof meta['map_x'] === 'number') map_x = meta['map_x'] as number
        if (typeof meta['map_y'] === 'number') map_y = meta['map_y'] as number
      } catch (_) {}

      try {
        const assets = await api.listEntityAssets(project, loc.slug)
        const img = assets.find(a => a.mime.startsWith('image/'))
        if (img) thumbUrl = api.assetFileUrl(project, img.id)
      } catch (_) {}

      return { entity: loc, map_x, map_y, thumbUrl }
    })
  )

  _buildOverlay(project, entries)
}

function _buildOverlay(project: string, entries: LocationEntry[]): void {
  // Remove existing overlay if any
  document.getElementById('world-map-overlay')?.remove()

  const overlay = document.createElement('div')
  overlay.id = 'world-map-overlay'
  overlay.className = 'wm-overlay'

  // Close on backdrop click
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove() }

  const container = document.createElement('div')
  container.className = 'wm-container'
  overlay.appendChild(container)

  // -- Tray (left, narrow) --
  const tray = document.createElement('div')
  tray.className = 'wm-tray'

  const trayTitle = document.createElement('div')
  trayTitle.className = 'wm-tray-title'
  trayTitle.textContent = 'Unplaced'
  tray.appendChild(trayTitle)

  const trayList = document.createElement('div')
  trayList.className = 'wm-tray-list'
  tray.appendChild(trayList)

  // -- Canvas (right, fills remainder) --
  const canvas = document.createElement('div')
  canvas.className = 'wm-canvas'

  // Grid overlay
  const grid = document.createElement('div')
  grid.className = 'wm-grid'
  canvas.appendChild(grid)

  // Close button
  const closeBtn = document.createElement('button')
  closeBtn.className = 'wm-close'
  closeBtn.textContent = 'x'
  closeBtn.title = 'Close map'
  closeBtn.onclick = () => overlay.remove()
  canvas.appendChild(closeBtn)

  container.appendChild(tray)
  container.appendChild(canvas)
  document.body.appendChild(overlay)

  // -- Populate --
  for (const entry of entries) {
    const card = _makeCard(entry)
    if (entry.map_x !== null && entry.map_y !== null) {
      _placeOnCanvas(canvas, trayList, card, entry, project, entry.map_x, entry.map_y)
    } else {
      _placeInTray(trayList, canvas, card, entry, project)
    }
  }
}

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

  return card
}

function _placeInTray(
  trayList: HTMLElement,
  canvas: HTMLElement,
  card: HTMLElement,
  entry: LocationEntry,
  project: string
): void {
  card.classList.add('wm-card--tray')
  trayList.appendChild(card)
  _makeDraggable(card, canvas, trayList, entry, project)
}

function _placeOnCanvas(
  canvas: HTMLElement,
  trayList: HTMLElement,
  card: HTMLElement,
  entry: LocationEntry,
  project: string,
  nx: number,
  ny: number
): void {
  card.classList.remove('wm-card--tray')
  card.classList.add('wm-card--placed')
  canvas.appendChild(card)
  _positionCard(card, canvas, nx, ny)
  _makeDraggable(card, canvas, trayList, entry, project)
}

function _positionCard(card: HTMLElement, canvas: HTMLElement, nx: number, ny: number): void {
  const cr = canvas.getBoundingClientRect()
  card.style.left = `${nx * cr.width}px`
  card.style.top = `${ny * cr.height}px`
}

function _makeDraggable(
  card: HTMLElement,
  canvas: HTMLElement,
  trayList: HTMLElement,
  entry: LocationEntry,
  project: string
): void {
  let startX = 0
  let startY = 0
  let ghost: HTMLElement | null = null

  const onMouseMove = (e: MouseEvent) => {
    if (!ghost) return
    ghost.style.left = `${e.clientX - startX}px`
    ghost.style.top  = `${e.clientY - startY}px`
  }

  const onMouseUp = async (e: MouseEvent) => {
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
    if (!ghost) return
    ghost.remove()
    ghost = null

    const canvasRect = canvas.getBoundingClientRect()
    const overCanvas = (
      e.clientX >= canvasRect.left &&
      e.clientX <= canvasRect.right &&
      e.clientY >= canvasRect.top &&
      e.clientY <= canvasRect.bottom
    )

    if (overCanvas) {
      // Place on canvas at drop position (card center under cursor)
      const cardW = card.offsetWidth  || 80
      const cardH = card.offsetHeight || 60
      const relX = e.clientX - canvasRect.left - cardW / 2
      const relY = e.clientY - canvasRect.top  - cardH / 2
      const nx = Math.max(0, Math.min(1, relX / canvasRect.width))
      const ny = Math.max(0, Math.min(1, relY / canvasRect.height))

      card.classList.remove('wm-card--tray')
      card.classList.add('wm-card--placed')
      canvas.appendChild(card)
      card.style.left = `${relX}px`
      card.style.top  = `${relY}px`
      entry.map_x = nx
      entry.map_y = ny

      try {
        await api.updateEntityMeta(project, entry.entity.slug, { map_x: nx, map_y: ny })
      } catch (err) {
        console.error('[terrrence] world-map: failed to save position', err)
      }
    } else {
      // Return to tray (unplace)
      if (card.classList.contains('wm-card--placed')) {
        card.classList.remove('wm-card--placed')
        card.classList.add('wm-card--tray')
        card.style.left = ''
        card.style.top  = ''
        trayList.appendChild(card)
        entry.map_x = null
        entry.map_y = null

        try {
          await api.updateEntityMeta(project, entry.entity.slug, { map_x: '', map_y: '' })
        } catch (err) {
          console.error('[terrrence] world-map: failed to clear position', err)
        }
      } else {
        // Was in tray, stayed in tray - just nothing to do
      }
    }
  }

  card.addEventListener('mousedown', (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const rect = card.getBoundingClientRect()
    startX = e.clientX - rect.left
    startY = e.clientY - rect.top

    // Create ghost for dragging
    ghost = card.cloneNode(true) as HTMLElement
    ghost.className = 'wm-card wm-card--ghost'
    ghost.style.position = 'fixed'
    ghost.style.left = `${rect.left}px`
    ghost.style.top  = `${rect.top}px`
    ghost.style.width = `${rect.width}px`
    ghost.style.pointerEvents = 'none'
    document.body.appendChild(ghost)

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  })
}
