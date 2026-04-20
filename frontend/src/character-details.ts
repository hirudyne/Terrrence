import { api, Asset } from './api'

const FACINGS = ['front', 'left', 'right', 'back'] as const
type Facing = typeof FACINGS[number]
const FACING_LABELS: Record<Facing, string> = { front: 'Front', left: 'Left', right: 'Right', back: 'Back' }
const GAITS = ['shuffle', 'stride', 'jog', 'waddle']
const N_FRAMES = 8

const facingRole = (f: Facing) => f === 'front' ? 'portrait' : `facing_${f}`
const sheetRole  = (f: Facing) => `walk_sheet_${f}`

export async function showCharacterDetails(
  projectSlug: string,
  characterSlug: string,
  characterName: string,
): Promise<void> {
  const existing = document.getElementById('char-details-overlay')
  if (existing) existing.remove()

  const overlay = document.createElement('div')
  overlay.id = 'char-details-overlay'
  overlay.className = 'char-details-overlay'

  const panel = document.createElement('div')
  panel.className = 'char-details-panel'
  overlay.appendChild(panel)

  const hdr = document.createElement('div')
  hdr.className = 'char-details-header'
  const titleEl = document.createElement('span')
  titleEl.className = 'char-details-title'
  titleEl.textContent = `Character Assets: ${characterName}`
  hdr.appendChild(titleEl)
  const closeBtn = document.createElement('button')
  closeBtn.className = 'char-details-close'
  closeBtn.textContent = 'Close'
  closeBtn.onclick = () => overlay.remove()
  hdr.appendChild(closeBtn)
  panel.appendChild(hdr)

  const body = document.createElement('div')
  body.className = 'char-details-body'
  panel.appendChild(body)

  document.body.appendChild(overlay)
  body.textContent = 'Loading...'

  const assets = await api.listEntityAssets(projectSlug, characterSlug)
  const byRole = new Map<string, Asset>()
  for (const a of assets) { if (a.role) byRole.set(a.role, a) }

  body.textContent = ''

  for (const facing of FACINGS) {
    const section = document.createElement('div')
    section.className = 'char-details-section'

    const sectionHdr = document.createElement('div')
    sectionHdr.className = 'char-details-section-hdr'
    sectionHdr.textContent = FACING_LABELS[facing]
    section.appendChild(sectionHdr)

    const facingRow = document.createElement('div')
    facingRow.className = 'char-details-facing-row'

    // --- Facing image slot ---
    const facingAsset = byRole.get(facingRole(facing))
    const facingSlot = document.createElement('div')
    facingSlot.className = 'char-details-facing-slot'

    const facingImg = document.createElement('div')
    facingImg.className = 'char-details-img-wrap'
    if (facingAsset) {
      const img = document.createElement('img')
      img.src = api.assetFileUrl(projectSlug, facingAsset.id)
      img.className = 'char-details-img'
      facingImg.appendChild(img)
    } else {
      facingImg.classList.add('char-details-img-wrap--empty')
      facingImg.textContent = 'No image'
    }
    facingSlot.appendChild(facingImg)

    const facingBtns = document.createElement('div')
    facingBtns.className = 'char-details-facing-btns'

    const genFacingBtn = document.createElement('button')
    genFacingBtn.className = 'char-details-btn'
    genFacingBtn.textContent = facingAsset ? 'Regenerate' : 'Generate'
    genFacingBtn.onclick = async () => {
      genFacingBtn.disabled = true
      genFacingBtn.textContent = 'Generating...'
      try {
        const resp = await fetch(
          `/projects/${projectSlug}/entities/${characterSlug}/generate-facing?facing=${facing}`,
          { method: 'POST', credentials: 'include' }
        )
        if (!resp.ok) { const e = await resp.json().catch(() => ({ detail: resp.statusText })); throw new Error(e.detail) }
        overlay.remove()
        showCharacterDetails(projectSlug, characterSlug, characterName)
      } catch (e: any) {
        genFacingBtn.textContent = 'Error'; genFacingBtn.title = e?.message ?? String(e)
        setTimeout(() => { genFacingBtn.disabled = false; genFacingBtn.textContent = facingAsset ? 'Regenerate' : 'Generate' }, 4000)
      }
    }
    facingBtns.appendChild(genFacingBtn)

    const upFacingBtn = document.createElement('button')
    upFacingBtn.className = 'char-details-btn char-details-btn--secondary'
    upFacingBtn.textContent = 'Upload'
    const upFacingInput = document.createElement('input')
    upFacingInput.type = 'file'; upFacingInput.accept = 'image/*'; upFacingInput.style.display = 'none'
    upFacingInput.onchange = async () => {
      const file = upFacingInput.files?.[0]; if (!file) return
      upFacingBtn.disabled = true; upFacingBtn.textContent = 'Uploading...'
      try {
        const fd = new FormData(); fd.append('file', file)
        const resp = await fetch(`/projects/${projectSlug}/assets`, { method: 'POST', credentials: 'include', body: fd })
        const a: Asset = await resp.json()
        await api.associateAsset(projectSlug, characterSlug, a.id, facingRole(facing))
        overlay.remove()
        showCharacterDetails(projectSlug, characterSlug, characterName)
      } catch (e: any) {
        upFacingBtn.textContent = 'Error'
        setTimeout(() => { upFacingBtn.disabled = false; upFacingBtn.textContent = 'Upload' }, 3000)
      }
    }
    upFacingBtn.onclick = () => upFacingInput.click()
    facingBtns.appendChild(upFacingBtn)
    facingBtns.appendChild(upFacingInput)
    facingSlot.appendChild(facingBtns)
    facingRow.appendChild(facingSlot)

    // --- Puppet walk content ---
    const puppetWrap = document.createElement('div')
    puppetWrap.className = 'char-details-puppet-wrap'

    // Controls row: gait + render button + error
    const renderRow = document.createElement('div')
    renderRow.className = 'char-details-render-controls'

    const gaitLabel = document.createElement('label')
    gaitLabel.className = 'char-details-render-label'
    gaitLabel.textContent = 'Gait: '
    const gaitSel = document.createElement('select')
    gaitSel.className = 'char-details-render-select'
    for (const g of GAITS) {
      const opt = document.createElement('option')
      opt.value = g; opt.textContent = g.charAt(0).toUpperCase() + g.slice(1)
      gaitSel.appendChild(opt)
    }
    gaitLabel.appendChild(gaitSel)
    renderRow.appendChild(gaitLabel)

    const renderBtn = document.createElement('button')
    renderBtn.className = 'char-details-btn char-details-btn--render'
    renderBtn.textContent = 'Render'
    renderBtn.disabled = !facingAsset
    renderBtn.title = facingAsset ? '' : 'Generate facing image first'
    renderRow.appendChild(renderBtn)

    const renderErr = document.createElement('span')
    renderErr.className = 'char-details-render-err'
    renderRow.appendChild(renderErr)

    puppetWrap.appendChild(renderRow)

    // Player canvas - animates the sheet
    const playerSection = document.createElement('div')
    playerSection.className = 'char-details-puppet-player'

    const canvas = document.createElement('canvas')
    canvas.className = 'char-details-puppet-canvas'
    playerSection.appendChild(canvas)

    // Player controls
    const playerControls = document.createElement('div')
    playerControls.className = 'char-details-player-controls'

    const playBtn = document.createElement('button')
    playBtn.className = 'char-details-btn char-details-btn--play'
    playBtn.textContent = 'Play'

    const fpsLabel = document.createElement('label')
    fpsLabel.className = 'char-details-player-label'
    fpsLabel.textContent = 'FPS: '
    const fpsInput = document.createElement('input')
    fpsInput.type = 'number'; fpsInput.min = '1'; fpsInput.max = '30'; fpsInput.value = '8'
    fpsInput.className = 'char-details-fps-input'
    fpsLabel.appendChild(fpsInput)

    playerControls.appendChild(playBtn)
    playerControls.appendChild(fpsLabel)
    playerSection.appendChild(playerControls)
    puppetWrap.appendChild(playerSection)

    // Sheet thumbnail (full strip)
    const sheetWrap = document.createElement('div')
    sheetWrap.className = 'char-details-sheet-wrap'

    // Player state
    let sheetImg: HTMLImageElement | null = null
    let frameW = 0
    let frameH = 0
    let currentFrame = 0
    let playInterval: ReturnType<typeof setInterval> | null = null

    function _drawFrame(n: number) {
      if (!sheetImg || frameW === 0) return
      const ctx = canvas.getContext('2d')!
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(sheetImg, n * frameW, 0, frameW, frameH, 0, 0, canvas.width, canvas.height)
    }

    function _loadSheet(asset: Asset) {
      const img = new Image()
      img.onload = () => {
        sheetImg = img
        frameW = img.naturalWidth / N_FRAMES
        frameH = img.naturalHeight
        // Size canvas to one frame, max 200px tall
        const scale = Math.min(1, 200 / frameH)
        canvas.width  = Math.round(frameW * scale)
        canvas.height = Math.round(frameH * scale)
        canvas.style.display = 'block'
        currentFrame = 0
        _drawFrame(0)
        playBtn.disabled = false

        // Also show full strip
        sheetWrap.innerHTML = ''
        sheetWrap.classList.remove('char-details-sheet-wrap--empty')
        const stripImg = document.createElement('img')
        stripImg.src = api.assetFileUrl(projectSlug, asset.id)
        stripImg.className = 'char-details-walk-sheet-img'
        sheetWrap.appendChild(stripImg)
      }
      img.src = api.assetFileUrl(projectSlug, asset.id)
    }

    // Load existing sheet if present
    const existingSheet = byRole.get(sheetRole(facing))
    if (existingSheet) {
      _loadSheet(existingSheet)
    } else {
      canvas.style.display = 'none'
      playBtn.disabled = true
      sheetWrap.classList.add('char-details-sheet-wrap--empty')
      sheetWrap.textContent = 'No puppet cycle rendered yet.'
    }

    // Play/stop
    playBtn.onclick = () => {
      if (playInterval) {
        clearInterval(playInterval); playInterval = null; playBtn.textContent = 'Play'
      } else {
        const fps = Math.max(1, Math.min(30, parseInt(fpsInput.value) || 8))
        playInterval = setInterval(() => {
          currentFrame = (currentFrame + 1) % N_FRAMES
          _drawFrame(currentFrame)
        }, 1000 / fps)
        playBtn.textContent = 'Stop'
      }
    }

    // Re-render
    renderBtn.addEventListener('click', async () => {
      if (playInterval) { clearInterval(playInterval); playInterval = null; playBtn.textContent = 'Play' }
      renderBtn.disabled = true; renderBtn.textContent = 'Rendering...'; renderErr.textContent = ''
      try {
        const result = await api.renderWalk(projectSlug, characterSlug, gaitSel.value, facing)
        byRole.set(sheetRole(facing), result)
        _loadSheet(result)
      } catch (e: any) {
        renderErr.textContent = e?.message ?? 'Render failed'
      }
      renderBtn.disabled = false; renderBtn.textContent = 'Render'
    })

    puppetWrap.appendChild(sheetWrap)
    facingRow.appendChild(puppetWrap)
    section.appendChild(facingRow)
    body.appendChild(section)
  }
}
