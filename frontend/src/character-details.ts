import { api, Asset } from './api'

const FACINGS = ['front', 'left', 'right', 'back'] as const
type Facing = typeof FACINGS[number]
const FACING_LABELS: Record<Facing, string> = { front: 'Front', left: 'Left', right: 'Right', back: 'Back' }
const GAITS = ['shuffle', 'stride', 'jog', 'waddle']
const N_FRAMES = 8

const facingRole  = (f: Facing) => f === 'front' ? 'portrait' : `facing_${f}`
const frameRole   = (f: Facing, n: number) => `walk_puppet_${f}_frame_${n}`

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
      genFacingBtn.disabled = true; genFacingBtn.textContent = 'Generating...'
      try {
        const resp = await fetch(
          `/projects/${projectSlug}/entities/${characterSlug}/generate-facing?facing=${facing}`,
          { method: 'POST', credentials: 'include' }
        )
        if (!resp.ok) { const e = await resp.json().catch(() => ({ detail: resp.statusText })); throw new Error(e.detail) }
        overlay.remove(); showCharacterDetails(projectSlug, characterSlug, characterName)
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
        overlay.remove(); showCharacterDetails(projectSlug, characterSlug, characterName)
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

    // Controls
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

    // Player
    const playerSection = document.createElement('div')
    playerSection.className = 'char-details-puppet-player'

    const playerImg = document.createElement('img')
    playerImg.className = 'char-details-puppet-canvas'

    const playerControls = document.createElement('div')
    playerControls.className = 'char-details-player-controls'

    const playBtn = document.createElement('button')
    playBtn.className = 'char-details-btn char-details-btn--play'
    playBtn.textContent = 'Play'
    playBtn.disabled = true

    const fpsLabel = document.createElement('label')
    fpsLabel.className = 'char-details-player-label'
    fpsLabel.textContent = 'FPS: '
    const fpsInput = document.createElement('input')
    fpsInput.type = 'number'; fpsInput.min = '1'; fpsInput.max = '30'; fpsInput.value = '8'
    fpsInput.className = 'char-details-fps-input'
    fpsLabel.appendChild(fpsInput)

    playerControls.appendChild(playBtn)
    playerControls.appendChild(fpsLabel)
    playerSection.appendChild(playerImg)
    playerSection.appendChild(playerControls)
    puppetWrap.appendChild(playerSection)

    // Player state
    let frameUrls: string[] = []
    let currentFrame = 0
    let playInterval: ReturnType<typeof setInterval> | null = null

    function _stopPlayer() {
      if (playInterval) { clearInterval(playInterval); playInterval = null; playBtn.textContent = 'Play' }
    }

    function _loadFrames(frameAssets: Asset[]) {
      frameUrls = frameAssets.map(a => api.assetFileUrl(projectSlug, a.id))
      currentFrame = 0
      playerImg.src = frameUrls[0]
      playerImg.style.display = 'block'
      playBtn.disabled = false
    }

    playBtn.onclick = () => {
      if (playInterval) {
        _stopPlayer()
      } else {
        if (!frameUrls.length) return
        const fps = Math.max(1, Math.min(30, parseInt(fpsInput.value) || 8))
        playInterval = setInterval(() => {
          currentFrame = (currentFrame + 1) % frameUrls.length
          playerImg.src = frameUrls[currentFrame]
        }, 1000 / fps)
        playBtn.textContent = 'Stop'
      }
    }

    // Load existing frames if present
    const existingFrames: Asset[] = []
    for (let i = 1; i <= N_FRAMES; i++) {
      const a = byRole.get(frameRole(facing, i))
      if (a) existingFrames.push(a)
    }
    if (existingFrames.length === N_FRAMES) {
      _loadFrames(existingFrames)
    } else {
      playerImg.style.display = 'none'
    }

    // Render
    renderBtn.addEventListener('click', async () => {
      _stopPlayer()
      renderBtn.disabled = true; renderBtn.textContent = 'Rendering...'; renderErr.textContent = ''
      try {
        const result = await api.renderWalk(projectSlug, characterSlug, gaitSel.value, facing)
        for (const fr of result.frames) { if (fr.role) byRole.set(fr.role, fr) }
        _loadFrames(result.frames)
      } catch (e: any) {
        renderErr.textContent = e?.message ?? 'Render failed'
      }
      renderBtn.disabled = !facingAsset; renderBtn.textContent = 'Render'
    })

    facingRow.appendChild(puppetWrap)
    section.appendChild(facingRow)
    body.appendChild(section)
  }
}
