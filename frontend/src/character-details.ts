import { api, Asset } from './api'

const FACINGS = ['front', 'left', 'right', 'back'] as const
type Facing = typeof FACINGS[number]

const FACING_LABELS: Record<Facing, string> = {
  front: 'Front',
  left: 'Left',
  right: 'Right',
  back: 'Back',
}

const WALK_FRAME_COUNT = 8

// Role names
const facingRole = (f: Facing) => f === 'front' ? 'portrait' : `facing_${f}`
const walkRole = (f: Facing, n: number) => `walk_${f}_frame_${n}`

export async function showCharacterDetails(
  projectSlug: string,
  characterSlug: string,
  characterName: string,
): Promise<void> {

  const overlay = document.createElement('div')
  overlay.className = 'char-details-overlay'

  const panel = document.createElement('div')
  panel.className = 'char-details-panel'
  overlay.appendChild(panel)

  // Header
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

  // Body - scrollable
  const body = document.createElement('div')
  body.className = 'char-details-body'
  panel.appendChild(body)

  document.body.appendChild(overlay)

  // Loading state
  body.textContent = 'Loading...'

  // Fetch all assets for this character
  const assets = await api.listEntityAssets(projectSlug, characterSlug)
  const byRole = new Map<string, Asset>()
  for (const a of assets) {
    if (a.role) byRole.set(a.role, a)
  }

  body.textContent = ''

  // For each facing: render a section with portrait/facing + walk frames
  for (const facing of FACINGS) {
    const section = document.createElement('div')
    section.className = 'char-details-section'

    const sectionHdr = document.createElement('div')
    sectionHdr.className = 'char-details-section-hdr'
    sectionHdr.textContent = FACING_LABELS[facing]
    section.appendChild(sectionHdr)

    const facingRow = document.createElement('div')
    facingRow.className = 'char-details-facing-row'

    // Facing image slot
    const facingSlot = document.createElement('div')
    facingSlot.className = 'char-details-facing-slot'
    const role = facingRole(facing)
    const facingAsset = byRole.get(role)

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

    // Generate button for facing
    const genFacingBtn = document.createElement('button')
    genFacingBtn.className = 'char-details-btn'
    genFacingBtn.textContent = facingAsset ? 'Regenerate' : 'Generate'
    genFacingBtn.onclick = async () => {
      genFacingBtn.disabled = true
      genFacingBtn.textContent = 'Generating...'
      try {
        await _generateFacing(projectSlug, characterSlug, facing, byRole)
        // Refresh
        overlay.remove()
        showCharacterDetails(projectSlug, characterSlug, characterName)
      } catch (e: any) {
        genFacingBtn.textContent = 'Error'
        genFacingBtn.title = e?.message ?? String(e)
        setTimeout(() => { genFacingBtn.disabled = false; genFacingBtn.textContent = facingAsset ? 'Regenerate' : 'Generate' }, 3000)
      }
    }
    facingSlot.appendChild(genFacingBtn)

    // Upload button for facing
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
        await api.associateAsset(projectSlug, characterSlug, a.id, role)
        overlay.remove()
        showCharacterDetails(projectSlug, characterSlug, characterName)
      } catch (e: any) {
        upFacingBtn.textContent = 'Error'; upFacingBtn.title = e?.message ?? String(e)
        setTimeout(() => { upFacingBtn.disabled = false; upFacingBtn.textContent = 'Upload' }, 3000)
      }
    }
    upFacingBtn.onclick = () => upFacingInput.click()
    facingSlot.appendChild(upFacingBtn)
    facingSlot.appendChild(upFacingInput)

    facingRow.appendChild(facingSlot)

    // Walk frames
    const walkWrap = document.createElement('div')
    walkWrap.className = 'char-details-walk-wrap'

    // Preview player
    const playerWrap = document.createElement('div')
    playerWrap.className = 'char-details-player'

    const playerImg = document.createElement('img')
    playerImg.className = 'char-details-player-img'

    const frameAssets: (Asset | undefined)[] = []
    for (let i = 1; i <= WALK_FRAME_COUNT; i++) {
      frameAssets.push(byRole.get(walkRole(facing, i)))
    }
    const frameUrls = frameAssets.map(a => a ? api.assetFileUrl(projectSlug, a.id) : null)
    const hasAnyFrame = frameUrls.some(u => u !== null)

    if (hasAnyFrame) {
      // Show first available frame initially
      const firstUrl = frameUrls.find(u => u !== null)!
      playerImg.src = firstUrl
      playerWrap.appendChild(playerImg)

      // FPS control + play/stop
      const playerControls = document.createElement('div')
      playerControls.className = 'char-details-player-controls'

      const fpsLabel = document.createElement('label')
      fpsLabel.textContent = 'FPS: '
      fpsLabel.className = 'char-details-player-label'
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
          clearInterval(_playInterval)
          _playInterval = null
          playBtn.textContent = 'Play'
        } else {
          const fps = Math.max(1, Math.min(30, parseInt(fpsInput.value) || 8))
          _playInterval = setInterval(() => {
            _frameIdx = (_frameIdx + 1) % validUrls.length
            playerImg.src = validUrls[_frameIdx]
          }, 1000 / fps)
          playBtn.textContent = 'Stop'
        }
      }

      // Scrub bar
      const scrub = document.createElement('input')
      scrub.type = 'range'; scrub.min = '0'; scrub.max = String(validUrls.length - 1); scrub.value = '0'
      scrub.className = 'char-details-scrub'
      scrub.oninput = () => {
        _frameIdx = parseInt(scrub.value)
        playerImg.src = validUrls[_frameIdx]
      }

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

    // Individual frame slots
    const framesRow = document.createElement('div')
    framesRow.className = 'char-details-frames-row'

    for (let i = 1; i <= WALK_FRAME_COUNT; i++) {
      const frameAsset = byRole.get(walkRole(facing, i))
      const slot = document.createElement('div')
      slot.className = 'char-details-frame-slot'

      const frameImg = document.createElement('div')
      frameImg.className = 'char-details-frame-thumb'
      if (frameAsset) {
        const img = document.createElement('img')
        img.src = api.assetFileUrl(projectSlug, frameAsset.id)
        frameImg.appendChild(img)
      } else {
        frameImg.classList.add('char-details-frame-thumb--empty')
      }
      slot.appendChild(frameImg)

      const frameLabel = document.createElement('div')
      frameLabel.className = 'char-details-frame-label'
      frameLabel.textContent = String(i)
      slot.appendChild(frameLabel)

      // Upload individual frame
      const upFrameBtn = document.createElement('button')
      upFrameBtn.className = 'char-details-frame-btn'
      upFrameBtn.title = `Upload frame ${i}`
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
      slot.appendChild(upFrameBtn)
      slot.appendChild(upFrameInput)

      framesRow.appendChild(slot)
    }
    walkWrap.appendChild(framesRow)

    // Generate all walk frames button
    if (byRole.has(facingRole(facing))) {
      const genWalkBtn = document.createElement('button')
      genWalkBtn.className = 'char-details-btn char-details-btn--walk-gen'
      genWalkBtn.textContent = 'Generate walk cycle'
      genWalkBtn.onclick = async () => {
        genWalkBtn.disabled = true
        genWalkBtn.textContent = 'Generating (0/8)...'
        try {
          await _generateWalkCycle(projectSlug, characterSlug, facing, byRole,
            (n) => { genWalkBtn.textContent = `Generating (${n}/8)...` })
          overlay.remove()
          showCharacterDetails(projectSlug, characterSlug, characterName)
        } catch (e: any) {
          genWalkBtn.textContent = 'Error'
          genWalkBtn.title = e?.message ?? String(e)
          setTimeout(() => { genWalkBtn.disabled = false; genWalkBtn.textContent = 'Generate walk cycle' }, 3000)
        }
      }
      walkWrap.appendChild(genWalkBtn)
    }

    facingRow.appendChild(walkWrap)
    section.appendChild(facingRow)
    body.appendChild(section)
  }
}

// ---------------------------------------------------------------------------
// Generation helpers
// ---------------------------------------------------------------------------

async function _generateFacing(
  projectSlug: string,
  entitySlug: string,
  facing: Facing,
  byRole: Map<string, Asset>,
): Promise<void> {
  const resp = await fetch(`/projects/${projectSlug}/entities/${entitySlug}/generate-facing?facing=${facing}`, {
    method: 'POST', credentials: 'include',
  })
  if (!resp.ok) {
    const e = await resp.json().catch(() => ({ detail: resp.statusText }))
    throw new Error(e.detail ?? resp.statusText)
  }
  const asset: Asset = await resp.json()
  byRole.set(facingRole(facing), asset)
}

async function _generateWalkCycle(
  projectSlug: string,
  entitySlug: string,
  facing: Facing,
  byRole: Map<string, Asset>,
  onProgress: (n: number) => void,
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
    const asset: Asset = await resp.json()
    byRole.set(walkRole(facing, i), asset)
    onProgress(i)
  }
}
