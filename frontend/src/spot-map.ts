import { api, Entity, EntityDetail } from './api'

interface Connection {
  id: string
  to: string
  from_edge?: unknown
  to_edge?: unknown
}

interface StartLocation {
  location: string
  x: number
  y: number
}

export async function showSpotMap(
  projectSlug: string,
  location: Entity,
  initialSpots: Entity[],
  onClose: () => void,
): Promise<void> {

  const [locDetail, ...spotDetails] = await Promise.all([
    api.getEntity(projectSlug, location.slug),
    ...initialSpots.map(s => api.getEntity(projectSlug, s.slug)),
  ])

  // Fetch characters and items with start_location matching this location
  const [allChars, allItems] = await Promise.all([
    api.listEntities(projectSlug, 'character'),
    api.listEntities(projectSlug, 'item'),
  ])
  const [charDetails, itemDetails]: [EntityDetail[], EntityDetail[]] = await Promise.all([
    Promise.all(allChars.map(c => api.getEntity(projectSlug, c.slug))),
    Promise.all(allItems.map(i => api.getEntity(projectSlug, i.slug))),
  ]) as [EntityDetail[], EntityDetail[]]
  const sceneChars = charDetails.filter(d => {
    const sl = (d.meta as Record<string, unknown>)?.['start_location'] as StartLocation | undefined
    return sl?.location === location.slug
  })
  const sceneItems = itemDetails.filter(d => {
    const sl = (d.meta as Record<string, unknown>)?.['start_location'] as StartLocation | undefined
    return sl?.location === location.slug
  })

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

  // Layer toggles
  const toggleWrap = document.createElement('div')
  toggleWrap.className = 'spot-map-toggles'

  let showSpots = true
  let showChars = true

  const mkToggle = (label: string, active: () => boolean, onClick: () => void) => {
    const btn = document.createElement('button')
    btn.className = 'spot-map-layer-btn'
    const update = () => btn.classList.toggle('active', active())
    btn.textContent = label
    btn.onclick = () => { onClick(); update(); _renderCanvas() }
    update()
    toggleWrap.appendChild(btn)
  }
  let showItems = true
  mkToggle('Spots', () => showSpots, () => { showSpots = !showSpots })
  mkToggle('Characters', () => showChars, () => { showChars = !showChars })
  mkToggle('Items', () => showItems, () => { showItems = !showItems })
  hdr.appendChild(toggleWrap)

  const closeBtn = document.createElement('button')
  closeBtn.className = 'spot-map-close'
  closeBtn.textContent = 'Close'
  closeBtn.onclick = () => { overlay.remove(); onClose() }
  hdr.appendChild(closeBtn)
  panel.appendChild(hdr)

  // Body
  const body = document.createElement('div')
  body.className = 'spot-map-body'

  const tray = document.createElement('div')
  tray.className = 'spot-map-tray'
  const trayHeading = document.createElement('div')
  trayHeading.className = 'spot-map-tray-heading'
  trayHeading.textContent = 'Unplaced spots'
  tray.appendChild(trayHeading)

  const canvasWrap = document.createElement('div')
  canvasWrap.className = 'spot-map-canvas-wrap'

  const canvas = document.createElement('div')
  canvas.className = 'spot-map-canvas'

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

  type SpotState = { entity: Entity; detail: EntityDetail }
  const spots: SpotState[] = spotDetails.map((d, i) => ({ entity: initialSpots[i], detail: d }))

  const locConnections: Connection[] = (locDetail.meta as Record<string, unknown>)?.['connections'] as Connection[] ?? []

  const _claimedConnections = (): Set<string> => {
    const claimed = new Set<string>()
    for (const s of spots) {
      const cid = (s.detail.meta as Record<string, unknown>)['connection_id'] as string | undefined
      if (cid) claimed.add(cid)
    }
    return claimed
  }

  // Character image cache: slug -> asset url or null
  const charImageCache: Map<string, string | null> = new Map()
  await Promise.all(sceneChars.map(async (c) => {
    const assets = await api.listEntityAssets(projectSlug, c.slug)
    const img = assets.find(a => a.mime.startsWith('image/'))
    charImageCache.set(c.slug, img ? api.assetFileUrl(projectSlug, img.id) : null)
  }))

  // Item image cache
  const itemImageCache: Map<string, string | null> = new Map()
  await Promise.all(sceneItems.map(async (item) => {
    const assets = await api.listEntityAssets(projectSlug, item.slug)
    const img = assets.find(a => a.mime.startsWith('image/'))
    itemImageCache.set(item.slug, img ? api.assetFileUrl(projectSlug, img.id) : null)
  }))

  let _openPanel: string | null = null

  const _renderTray = () => {
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
        e.dataTransfer!.setData('text/plain', `spot:${s.entity.slug}`)
        e.dataTransfer!.effectAllowed = 'move'
      }
      tray.appendChild(card)
    }
  }

  const _renderCanvas = () => {
    canvas.querySelectorAll('.spot-card, .spot-detail-panel, .char-card').forEach(c => c.remove())
    const claimed = _claimedConnections()

    // -- spots layer --
    if (showSpots) {
      for (const s of spots) {
        const meta = s.detail.meta as Record<string, unknown>
        const sx = meta['spot_x']
        const sy = meta['spot_y']
        if (sx === undefined || sx === '' || sx === null) continue
        const x = Number(sx)
        const y = Number(sy)
        const temp = (meta['temperature'] as string) ?? 'cold'
        const connId = (meta['connection_id'] as string) ?? ''

        const card = document.createElement('div')
        card.className = `spot-card spot-card--${temp}`
        card.style.left = `${x * 100}%`
        card.style.top = `${y * 100}%`
        card.title = `${s.entity.display_name} [${temp}]${connId ? ' [exit: ' + connId + ']' : ''}`
        card.dataset.slug = s.entity.slug
        card.dataset.layer = 'spot'

        const label = document.createElement('span')
        label.className = 'spot-card-label'
        label.textContent = s.entity.display_name
        card.appendChild(label)

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
            if (_openPanel === s.entity.slug) _openPanel = null
            _renderCanvas()
            _renderTray()
          } catch (err) { console.debug('[terrrence] unplace error', err) }
        }
        card.appendChild(unplaceBtn)

        const detailToggle = document.createElement('button')
        detailToggle.className = 'spot-detail-toggle'
        detailToggle.title = 'Connection / settings'
        detailToggle.textContent = connId ? 'E' : '+'
        detailToggle.onclick = (e) => {
          e.stopPropagation()
          _openPanel = _openPanel === s.entity.slug ? null : s.entity.slug
          _renderCanvas()
        }
        card.appendChild(detailToggle)

        card.draggable = true
        card.ondragstart = (e) => {
          e.dataTransfer!.setData('text/plain', `spot:${s.entity.slug}`)
          e.dataTransfer!.effectAllowed = 'move'
        }

        canvas.appendChild(card)

        if (_openPanel === s.entity.slug) {
          const dp = document.createElement('div')
          dp.className = 'spot-detail-panel'
          dp.style.left = `${x * 100}%`
          dp.style.top = `calc(${y * 100}% + 24px)`

          const dpTitle = document.createElement('div')
          dpTitle.className = 'spot-detail-title'
          dpTitle.textContent = s.entity.display_name
          dp.appendChild(dpTitle)

          const connLabel = document.createElement('label')
          connLabel.className = 'spot-detail-label'
          connLabel.textContent = 'Exit connection'
          dp.appendChild(connLabel)

          const connSel = document.createElement('select')
          connSel.className = 'spot-detail-select'
          const noneOpt = document.createElement('option')
          noneOpt.value = ''
          noneOpt.textContent = '(none)'
          connSel.appendChild(noneOpt)
          for (const conn of locConnections) {
            if (claimed.has(conn.id) && conn.id !== connId) continue
            const opt = document.createElement('option')
            opt.value = conn.id
            opt.textContent = `-> ${conn.to} (${conn.id})`
            if (conn.id === connId) opt.selected = true
            connSel.appendChild(opt)
          }
          connSel.onchange = async () => {
            const newConnId = connSel.value
            try {
              await api.updateEntityMeta(projectSlug, s.entity.slug, { connection_id: newConnId === '' ? '' : newConnId })
              ;(s.detail.meta as Record<string, unknown>)['connection_id'] = newConnId || undefined
              _renderCanvas()
            } catch (err) { console.debug('[terrrence] connection_id save error', err) }
          }
          dp.appendChild(connSel)

          const dpClose = document.createElement('button')
          dpClose.className = 'spot-detail-close'
          dpClose.textContent = 'Done'
          dpClose.onclick = (e) => { e.stopPropagation(); _openPanel = null; _renderCanvas() }
          dp.appendChild(dpClose)

          canvas.appendChild(dp)
        }
      }
    }

    // -- items layer --
    if (showItems) {
      for (const item of sceneItems) {
        const sl = (item.meta as Record<string, unknown>)?.['start_location'] as StartLocation | undefined
        if (!sl) continue
        const x = sl.x ?? 0.5
        const y = sl.y ?? 0.5
        const imgUrl = itemImageCache.get(item.slug) ?? null

        const card = document.createElement('div')
        card.className = 'item-card'
        card.style.left = `${x * 100}%`
        card.style.top = `${y * 100}%`
        card.title = item.display_name
        card.dataset.slug = item.slug
        card.dataset.layer = 'item'
        card.draggable = true

        if (imgUrl) {
          card.style.backgroundImage = `url(${imgUrl})`
          card.style.backgroundSize = 'contain'
          card.style.backgroundRepeat = 'no-repeat'
          card.style.backgroundPosition = 'center'
        } else {
          const label = document.createElement('span')
          label.className = 'item-card-label'
          label.textContent = item.display_name
          card.appendChild(label)
        }

        const nameTag = document.createElement('span')
        nameTag.className = 'item-card-nametag'
        nameTag.textContent = item.display_name
        card.appendChild(nameTag)

        card.ondragstart = (e) => {
          e.dataTransfer!.setData('text/plain', `item:${item.slug}`)
          e.dataTransfer!.effectAllowed = 'move'
        }
        canvas.appendChild(card)
      }
    }

    // -- characters layer --
    if (showChars) {
      for (const c of sceneChars) {
        const sl = (c.meta as Record<string, unknown>)?.['start_location'] as StartLocation | undefined
        if (!sl) continue
        const x = sl.x ?? 0.5
        const y = sl.y ?? 0.5
        const imgUrl = charImageCache.get(c.slug) ?? null

        const card = document.createElement('div')
        card.className = 'char-card'
        card.style.left = `${x * 100}%`
        card.style.top = `${y * 100}%`
        card.title = c.display_name
        card.dataset.slug = c.slug
        card.dataset.layer = 'char'
        card.draggable = true

        if (imgUrl) {
          card.style.backgroundImage = `url(${imgUrl})`
          card.style.backgroundSize = 'cover'
          card.style.backgroundPosition = 'center'
        } else {
          const label = document.createElement('span')
          label.className = 'char-card-label'
          label.textContent = c.display_name
          card.appendChild(label)
        }

        const nameTag = document.createElement('span')
        nameTag.className = 'char-card-nametag'
        nameTag.textContent = c.display_name
        card.appendChild(nameTag)

        card.ondragstart = (e) => {
          e.dataTransfer!.setData('text/plain', `char:${c.slug}`)
          e.dataTransfer!.effectAllowed = 'move'
        }

        canvas.appendChild(card)
      }
    }
  }

  canvas.ondragover = (e) => { e.preventDefault(); e.dataTransfer!.dropEffect = 'move' }
  canvas.ondrop = async (e) => {
    e.preventDefault()
    const raw = e.dataTransfer!.getData('text/plain')
    const rect = canvas.getBoundingClientRect()
    const nx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const ny = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))

    if (raw.startsWith('spot:')) {
      const slug = raw.slice(5)
      const s = spots.find(sp => sp.entity.slug === slug)
      if (!s) return
      try {
        await api.updateEntityMeta(projectSlug, slug, { spot_x: nx, spot_y: ny })
        ;(s.detail.meta as Record<string, unknown>)['spot_x'] = nx
        ;(s.detail.meta as Record<string, unknown>)['spot_y'] = ny
        _renderCanvas()
        _renderTray()
      } catch (err) { console.debug('[terrrence] spot place error', err) }

    } else if (raw.startsWith('item:')) {
      const slug = raw.slice(5)
      const item = sceneItems.find(i => i.slug === slug)
      if (!item) return
      const sl = (item.meta as Record<string, unknown>)?.['start_location'] as StartLocation | undefined
      if (!sl) return
      try {
        const updated = { location: sl.location, x: nx, y: ny }
        await api.updateEntityMeta(projectSlug, slug, { start_location: updated })
        ;(item.meta as Record<string, unknown>)['start_location'] = updated
        _renderCanvas()
      } catch (err) { console.debug('[terrrence] item drag error', err) }

    } else if (raw.startsWith('char:')) {
      const slug = raw.slice(5)
      const c = sceneChars.find(ch => ch.slug === slug)
      if (!c) return
      const sl = (c.meta as Record<string, unknown>)?.['start_location'] as StartLocation | undefined
      if (!sl) return
      try {
        const updated = { location: sl.location, x: nx, y: ny }
        await api.updateEntityMeta(projectSlug, slug, { start_location: updated })
        ;(c.meta as Record<string, unknown>)['start_location'] = updated
        _renderCanvas()
      } catch (err) { console.debug('[terrrence] char drag error', err) }
    }
  }

  _renderTray()
  _renderCanvas()
}
