import { api, Asset } from './api'

const FACINGS = ['front', 'left', 'right', 'back'] as const
type Facing = typeof FACINGS[number]

const FACING_LABELS: Record<Facing, string> = {
  front: 'Front', left: 'Left', right: 'Right', back: 'Back',
}

const WALK_FRAME_COUNT = 8
const GAITS = ['shuffle', 'stride', 'jog', 'waddle']

const facingRole = (f: Facing) => f === 'front' ? 'portrait' : `facing_${f}`
const walkRole = (f: Facing, n: number) => `walk_${f}_frame_${n}`
const sheetRole = (f: Facing) => `walk_sheet_${f}`

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
    const facingSlot = document.createElement('div')
    facingSlot.className = 'char-details-facing-slot'

    const facingAsset = byRole.get(facingRole(facing))
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
        await _generateFacing(projectSlug, characterSlug, facing, byRole)
        overlay.remove()
        showCharacterDetails(projectSlug, characterSlug, characterName)
      } catch (e: any) {
        genFacingBtn.textContent = 'Error'
        genFacingBtn.title = e?.message ?? String(e)
        setTimeout(() => { genFacingBtn.disabled = false; genFacingBtn.textContent = facingAsset ? 'Regenerate' : 'Generate' }, 3000)
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

    // --- Walk content (right side) ---
    const walkWrap = document.createElement('div')
    walkWrap.className = 'char-details-walk-wrap'

    // Walk frame player
    const playerWrap = document.createElement('div')
    playerWrap.className = 'char-details-player'

    const frameAssets: (Asset | undefined)[] = []
    for (let i = 1; i <= WALK_FRAME_COUNT; i++) frameAssets.push(byRole.get(walkRole(facing, i)))
    const frameUrls = frameAssets.map(a => a ? api.assetFileUrl(projectSlug, a.id) : null)
    const hasAnyFrame = frameUrls.some(u => u !== null)

    if (hasAnyFrame) {
      const playerImg = document.createElement('img')
      playerImg.className = 'char-details-player-img'
      playerImg.src = frameUrls.find(u => u !== null)!
      playerWrap.appendChild(playerImg)

      const playerControls = document.createElement('div')
      playerControls.className = 'char-details-player-controls'
      const fpsLabel = document.createElement('label')
      fpsLabel.className = 'char-details-player-label'
      fpsLabel.textContent = 'FPS: '
      const fpsInput = document.createElement('input')
      fpsInput.type = 'number'; fpsInput.min = '1'; fpsInput.max = '30'; fpsInput.value = '8'
      fpsInput.className = 'char-details-fps-input'
      let _playInterval: ReturnType<typeof setInterval> | null = null
      let _frameIdx = 0
      const validUrls = frameUrls.filter(u => u !== null) as string[]
      const playBtn = document.createElement('button')
      playBtn.className = 'char-details-btn char-details-btn--play'
      playBtn.textContent = 'Play'
      playBtn.onclick = () => {
        if (_playInterval) {
          clearInterval(_playInterval); _playInterval = null; playBtn.textContent = 'Play'
        } else {
          const fps = Math.max(1, Math.min(30, parseInt(fpsInput.value) || 8))
          _playInterval = setInterval(() => {
            _frameIdx = (_frameIdx + 1) % validUrls.length; playerImg.src = validUrls[_frameIdx]
          }, 1000 / fps)
          playBtn.textContent = 'Stop'
        }
      }
      const scrub = document.createElement('input')
      scrub.type = 'range'; scrub.min = '0'; scrub.max = String(validUrls.length - 1); scrub.value = '0'
      scrub.className = 'char-details-scrub'
      scrub.oninput = () => { _frameIdx = parseInt(scrub.value); playerImg.src = validUrls[_frameIdx] }
      fpsLabel.appendChild(fpsInput)
      playerControls.appendChild(playBtn)
      playerControls.appendChild(fpsLabel)
      playerControls.appendChild(scrub)
      playerWrap.appendChild(playerControls)
    } else {
      playerWrap.textContent = 'No walk frames yet'
      playerWrap.classList.add('char-details-player--empty')
    }
    walkWrap.appendChild(playerWrap)

    // Frame strip
    const framesRow = document.createElement('div')
    framesRow.className = 'char-details-frames-row'
    for (let i = 1; i <= WALK_FRAME_COUNT; i++) {
      const frameAsset = byRole.get(walkRole(facing, i))
      const slot = document.createElement('div')
      slot.className = 'char-details-frame-slot'
      const frameImg = document.createElement('div')
      frameImg.className = 'char-details-frame-thumb'
      if (frameAsset) {
        const img = document.createElement('img'); img.src = api.assetFileUrl(projectSlug, frameAsset.id)
        frameImg.appendChild(img)
      } else {
        frameImg.classList.add('char-details-frame-thumb--empty')
      }
      slot.appendChild(frameImg)
      const frameLabel = document.createElement('div')
      frameLabel.className = 'char-details-frame-label'
      frameLabel.textContent = String(i)
      slot.appendChild(frameLabel)
      const upFrameBtn = document.createElement('button')
      upFrameBtn.className = 'char-details-frame-btn'
      upFrameBtn.textContent = frameAsset ? '↑' : '+'
      const upFrameInput = document.createElement('input')
      upFrameInput.type = 'file'; upFrameInput.accept = 'image/*'; upFrameInput.style.display = 'none'
      upFrameInput.onchange = async () => {
        const file = upFrameInput.files?.[0]; if (!file) return
        upFrameBtn.disabled = true
        try {
          const fd = new FormData(); fd.append('file', file)
          const resp = await fetch(`/projects/${projectSlug}/assets`, { method: 'POST', credentials: 'include', body: fd })
          const a: Asset = await resp.json()
          await api.associateAsset(projectSlug, characterSlug, a.id, walkRole(facing, i))
          overlay.remove()
          showCharacterDetails(projectSlug, characterSlug, characterName)
        } catch { upFrameBtn.disabled = false }
      }
      upFrameBtn.onclick = () => upFrameInput.click()
      slot.appendChild(upFrameBtn); slot.appendChild(upFrameInput)
      framesRow.appendChild(slot)
    }
    walkWrap.appendChild(framesRow)

    // Generate walk frames button (only if facing image exists)
    if (facingAsset) {
      const genWalkBtn = document.createElement('button')
      genWalkBtn.className = 'char-details-btn char-details-btn--walk-gen'
      genWalkBtn.textContent = 'Generate walk frames'
      genWalkBtn.onclick = async () => {
        genWalkBtn.disabled = true
        genWalkBtn.textContent = 'Generating (0/8)...'
        try {
          await _generateWalkCycle(projectSlug, characterSlug, facing, byRole,
            (n) => { genWalkBtn.textContent = `Generating (${n}/8)...` })
          overlay.remove()
          showCharacterDetails(projectSlug, characterSlug, characterName)
        } catch (e: any) {
          genWalkBtn.textContent = 'Error'; genWalkBtn.title = e?.message ?? String(e)
          setTimeout(() => { genWalkBtn.disabled = false; genWalkBtn.textContent = 'Generate walk frames' }, 3000)
        }
      }
      walkWrap.appendChild(genWalkBtn)
    }

    // --- Puppet render row (per facing) ---
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
    renderBtn.textContent = 'Render puppet cycle'
    renderBtn.disabled = !facingAsset
    renderBtn.title = facingAsset ? '' : 'Generate facing image first'
    renderRow.appendChild(renderBtn)

    const renderErr = document.createElement('span')
    renderErr.className = 'char-details-render-err'
    renderRow.appendChild(renderErr)

    walkWrap.appendChild(renderRow)

    // Sheet preview (per facing)
    const existingSheet = byRole.get(sheetRole(facing))
    const sheetWrap = document.createElement('div')
    sheetWrap.className = 'char-details-sheet-wrap'
    if (existingSheet) {
      const img = document.createElement('img')
      img.src = api.assetFileUrl(projectSlug, existingSheet.id)
      img.className = 'char-details-walk-sheet-img'
      sheetWrap.appendChild(img)
    } else {
      sheetWrap.classList.add('char-details-sheet-wrap--empty')
      sheetWrap.textContent = 'No puppet cycle rendered yet.'
    }
    walkWrap.appendChild(sheetWrap)

    renderBtn.addEventListener('click', async () => {
      renderBtn.disabled = true; renderBtn.textContent = 'Rendering...'; renderErr.textContent = ''
      try {
        const result = await api.renderWalk(projectSlug, characterSlug, gaitSel.value, facing)
        byRole.set(sheetRole(facing), result)
        sheetWrap.innerHTML = ''
        sheetWrap.classList.remove('char-details-sheet-wrap--empty')
        const img = document.createElement('img')
        img.src = api.assetFileUrl(projectSlug, result.id)
        img.className = 'char-details-walk-sheet-img'
        sheetWrap.appendChild(img)
      } catch (e: any) {
        renderErr.textContent = e?.message ?? 'Render failed'
      }
      renderBtn.disabled = !facingAsset; renderBtn.textContent = 'Render puppet cycle'
    })

    facingRow.appendChild(walkWrap)
    section.appendChild(facingRow)
    body.appendChild(section)
  }
}

// ---------------------------------------------------------------------------
// Generation helpers
// ---------------------------------------------------------------------------

async function _generateFacing(
  projectSlug: string, entitySlug: string, facing: Facing, byRole: Map<string, Asset>,
): Promise<void> {
  const resp = await fetch(
    `/projects/${projectSlug}/entities/${entitySlug}/generate-facing?facing=${facing}`,
    { method: 'POST', credentials: 'include' }
  )
  if (!resp.ok) {
    const e = await resp.json().catch(() => ({ detail: resp.statusText }))
    throw new Error(e.detail ?? resp.statusText)
  }
  byRole.set(facingRole(facing), await resp.json())
}

async function _generateWalkCycle(
  projectSlug: string, entitySlug: string, facing: Facing,
  byRole: Map<string, Asset>, onProgress: (n: number) => void,
): Promise<void> {
  for (let i = 1; i <= WALK_FRAME_COUNT; i++) {
    const resp = await fetch(
      `/projects/${projectSlug}/entities/${entitySlug}/generate-walk-frame?facing=${facing}&frame=${i}`,
      { method: 'POST', credentials: 'include' }
    )
    if (!resp.ok) {
      const e = await resp.json().catch(() => ({ detail: resp.statusText }))
      throw new Error(e.detail ?? resp.statusText)
    }
    byRole.set(walkRole(facing, i), await resp.json())
    onProgress(i)
  }
}
