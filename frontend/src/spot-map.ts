import { api, Entity, EntityDetail } from './api'

export async function showSpotMap(
  projectSlug: string,
  location: Entity,
  initialSpots: Entity[],
  onClose: () => void,
): Promise<void> {

  // Fetch full details for location (scene_image) and all spots (meta: x, y, temperature)
  const [locDetail, ...spotDetails] = await Promise.all([
    api.getEntity(projectSlug, location.slug),
    ...initialSpots.map(s => api.getEntity(projectSlug, s.slug)),
  ])

  const overlay = document.createElement('div')
  overlay.className = 'spot-map-overlay'

  const panel = document.createElement('div')
  panel.className = 'spot-map-panel'
  overlay.appendChild(panel)

  // Header
  const hdr = document.createElement('div')
  hdr.className = 'spot-map-header'
  const title = document.createElement('span')
  title.className = 'spot-map-title'
  title.textContent = `Spot Map: ${location.display_name}`
  hdr.appendChild(title)
  const closeBtn = document.createElement('button')
  closeBtn.className = 'spot-map-close'
  closeBtn.textContent = 'Close'
  closeBtn.onclick = () => { overlay.remove(); onClose() }
  hdr.appendChild(closeBtn)
  panel.appendChild(hdr)

  // Body: tray + canvas
  const body = document.createElement('div')
  body.className = 'spot-map-body'

  // Left tray - unplaced spots
  const tray = document.createElement('div')
  tray.className = 'spot-map-tray'
  const trayHeading = document.createElement('div')
  trayHeading.className = 'spot-map-tray-heading'
  trayHeading.textContent = 'Unplaced spots'
  tray.appendChild(trayHeading)

  // Canvas area
  const canvasWrap = document.createElement('div')
  canvasWrap.className = 'spot-map-canvas-wrap'

  const canvas = document.createElement('div')
  canvas.className = 'spot-map-canvas'

  // Background image
  const sceneImageId = (locDetail.meta as Record<string, unknown>)?.['scene_image'] as number | null ?? null
  if (sceneImageId) {
    canvas.style.backgroundImage = `url(${api.assetFileUrl(projectSlug, sceneImageId)})`
    canvas.style.backgroundSize = 'contain'
    canvas.style.backgroundRepeat = 'no-repeat'
    canvas.style.backgroundPosition = 'center'
  }

  canvasWrap.appendChild(canvas)
  body.appendChild(tray)
  body.appendChild(canvasWrap)
  panel.appendChild(body)
  document.body.appendChild(overlay)

  // Build spot state from details
  type SpotState = {
    entity: Entity
    detail: EntityDetail
    el: HTMLElement | null   // null = in tray
  }

  const spots: SpotState[] = spotDetails.map((d, i) => ({
    entity: initialSpots[i],
    detail: d,
    el: null,
  }))

  const _renderTray = () => {
    // Remove old tray cards
    tray.querySelectorAll('.spot-tray-card').forEach(c => c.remove())
    for (const s of spots) {
      const meta = s.detail.meta as Record<string, unknown>
      const hasPos = meta['spot_x'] !== undefined && meta['spot_x'] !== '' && meta['spot_x'] !== null
      if (hasPos) continue
      const card = document.createElement('div')
      card.className = 'spot-tray-card'
      card.textContent = s.entity.display_name
      card.title = s.entity.slug
      card.draggable = true
      card.dataset.slug = s.entity.slug
      card.ondragstart = (e) => {
        e.dataTransfer!.setData('text/plain', s.entity.slug)
        e.dataTransfer!.effectAllowed = 'move'
      }
      tray.appendChild(card)
    }
  }

  const _renderCanvas = () => {
    canvas.querySelectorAll('.spot-card').forEach(c => c.remove())
    for (const s of spots) {
      const meta = s.detail.meta as Record<string, unknown>
      const sx = meta['spot_x']
      const sy = meta['spot_y']
      if (sx === undefined || sx === '' || sx === null) continue
      const x = Number(sx)
      const y = Number(sy)
      const temp = (meta['temperature'] as string) ?? 'cold'

      const card = document.createElement('div')
      card.className = `spot-card spot-card--${temp}`
      card.style.left = `${x * 100}%`
      card.style.top = `${y * 100}%`
      card.title = `${s.entity.display_name} [${temp}]`
      card.dataset.slug = s.entity.slug

      const label = document.createElement('span')
      label.className = 'spot-card-label'
      label.textContent = s.entity.display_name
      card.appendChild(label)

      // Temperature toggle button
      const toggleBtn = document.createElement('button')
      toggleBtn.className = 'spot-temp-btn'
      toggleBtn.title = `Toggle temperature (currently ${temp})`
      toggleBtn.textContent = temp === 'hot' ? 'H' : 'C'
      toggleBtn.onclick = async (e) => {
        e.stopPropagation()
        const newTemp = temp === 'hot' ? 'cold' : 'hot'
        try {
          await api.updateEntityMeta(projectSlug, s.entity.slug, { temperature: newTemp })
          ;(s.detail.meta as Record<string, unknown>)['temperature'] = newTemp
          _renderCanvas()
        } catch (err) { console.debug('[terrrence] temp toggle error', err) }
      }
      card.appendChild(toggleBtn)

      // Unplace button
      const unplaceBtn = document.createElement('button')
      unplaceBtn.className = 'spot-unplace-btn'
      unplaceBtn.title = 'Remove from map'
      unplaceBtn.textContent = 'x'
      unplaceBtn.onclick = async (e) => {
        e.stopPropagation()
        try {
          await api.updateEntityMeta(projectSlug, s.entity.slug, { spot_x: '', spot_y: '' })
          ;(s.detail.meta as Record<string, unknown>)['spot_x'] = undefined
          ;(s.detail.meta as Record<string, unknown>)['spot_y'] = undefined
          _renderCanvas()
          _renderTray()
        } catch (err) { console.debug('[terrrence] unplace error', err) }
      }
      card.appendChild(unplaceBtn)

      // Drag to reposition
      card.draggable = true
      card.ondragstart = (e) => {
        e.dataTransfer!.setData('text/plain', s.entity.slug)
        e.dataTransfer!.effectAllowed = 'move'
      }

      canvas.appendChild(card)
    }
  }

  // Drop on canvas - place or reposition
  canvas.ondragover = (e) => { e.preventDefault(); e.dataTransfer!.dropEffect = 'move' }
  canvas.ondrop = async (e) => {
    e.preventDefault()
    const slug = e.dataTransfer!.getData('text/plain')
    const s = spots.find(sp => sp.entity.slug === slug)
    if (!s) return
    const rect = canvas.getBoundingClientRect()
    const nx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const ny = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))
    try {
      await api.updateEntityMeta(projectSlug, slug, { spot_x: nx, spot_y: ny })
      ;(s.detail.meta as Record<string, unknown>)['spot_x'] = nx
      ;(s.detail.meta as Record<string, unknown>)['spot_y'] = ny
      _renderCanvas()
      _renderTray()
    } catch (err) { console.debug('[terrrence] spot place error', err) }
  }

  _renderTray()
  _renderCanvas()
}
