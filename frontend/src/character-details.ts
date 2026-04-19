import { api } from './api'

const PART_TYPES = ['hair','head','torso','upper_arm','lower_arm','hand','upper_leg','lower_leg','foot'] as const
type PartType = typeof PART_TYPES[number]

const PART_LABELS: Record<PartType, string> = {
  hair: 'Hair', head: 'Head', torso: 'Torso',
  upper_arm: 'Upper Arm', lower_arm: 'Lower Arm', hand: 'Hand',
  upper_leg: 'Upper Leg', lower_leg: 'Lower Leg', foot: 'Foot',
}

const GAIT_STYLES = ['shuffle','stride','jog','waddle'] as const
type GaitStyle = typeof GAIT_STYLES[number]

export async function showCharacterDetails(
  projectSlug: string,
  entitySlug: string,
  characterName: string,
) {
  const existing = document.getElementById('char-details-modal')
  if (existing) existing.remove()

  const assets = await api.listEntityAssets(projectSlug, entitySlug)
  const byRole = new Map(assets.map((a: any) => [a.role, a]))

  const overlay = document.createElement('div')
  overlay.id = 'char-details-modal'
  overlay.className = 'char-details-overlay'
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })

  const modal = document.createElement('div')
  modal.className = 'char-details-modal'

  const hdr = document.createElement('div')
  hdr.className = 'char-details-hdr'
  hdr.innerHTML = `<span class="char-details-title">${characterName} - Character Parts</span>`
  const closeBtn = document.createElement('button')
  closeBtn.className = 'char-details-close'
  closeBtn.textContent = 'x'
  closeBtn.addEventListener('click', () => overlay.remove())
  hdr.appendChild(closeBtn)
  modal.appendChild(hdr)

  const body = document.createElement('div')
  body.className = 'char-details-body'

  // --- Parts grid ---
  const partsSection = document.createElement('div')
  partsSection.className = 'char-details-parts-section'
  const partsSectionHdr = document.createElement('div')
  partsSectionHdr.className = 'char-details-section-hdr'
  partsSectionHdr.textContent = 'Body Parts'
  partsSection.appendChild(partsSectionHdr)

  const partsGrid = document.createElement('div')
  partsGrid.className = 'char-details-parts-grid'

  const headExists = () => byRole.has('part_head')

  for (const pt of PART_TYPES) {
    const role = `part_${pt}`
    const cell = document.createElement('div')
    cell.className = 'char-details-part-cell'
    cell.dataset.part = pt

    const label = document.createElement('div')
    label.className = 'char-details-part-label'
    label.textContent = PART_LABELS[pt]
    cell.appendChild(label)

    const imgWrap = document.createElement('div')
    imgWrap.className = 'char-details-img-wrap'
    const asset = byRole.get(role)
    if (asset) {
      const img = document.createElement('img')
      img.src = api.assetFileUrl(projectSlug, asset.id)
      imgWrap.appendChild(img)
    } else {
      imgWrap.classList.add('char-details-img-wrap--empty')
      imgWrap.textContent = 'None'
    }
    cell.appendChild(imgWrap)

    const genBtn = document.createElement('button')
    genBtn.className = 'char-details-btn'
    genBtn.textContent = asset ? 'Regen' : 'Generate'
    const isNonHead = pt !== 'head'
    if (isNonHead && !headExists()) {
      genBtn.disabled = true
      genBtn.title = 'Generate head first'
    }
    genBtn.addEventListener('click', async () => {
      if (isNonHead && !headExists()) return
      genBtn.disabled = true
      genBtn.textContent = 'Generating...'
      try {
        const result = await api.generatePart(projectSlug, entitySlug, pt)
        byRole.set(role, result)
        if (pt === 'head') {
          partsGrid.querySelectorAll<HTMLButtonElement>('.char-details-btn').forEach(b => {
            b.disabled = false
            b.title = ''
          })
          renderBtn.disabled = false
          renderBtn.title = ''
        }
        imgWrap.innerHTML = ''
        imgWrap.classList.remove('char-details-img-wrap--empty')
        const img = document.createElement('img')
        img.src = api.assetFileUrl(projectSlug, result.id)
        imgWrap.appendChild(img)
        genBtn.textContent = 'Regen'
        genBtn.disabled = false
      } catch (e: any) {
        console.error('generate-part failed:', e)
        genBtn.textContent = 'Error'
        errDiv.textContent = e?.message ?? 'Generation failed'
        setTimeout(() => {
          genBtn.disabled = isNonHead && !headExists()
          genBtn.textContent = asset ? 'Regen' : 'Generate'
          errDiv.textContent = ''
        }, 5000)
      }
    })
    cell.appendChild(genBtn)
    const errDiv = document.createElement('div')
    errDiv.className = 'char-details-part-err'
    cell.appendChild(errDiv)
    partsGrid.appendChild(cell)
  }
  partsSection.appendChild(partsGrid)
  body.appendChild(partsSection)

  // --- Walk cycle section ---
  const walkSection = document.createElement('div')
  walkSection.className = 'char-details-walk-section'
  const walkSectionHdr = document.createElement('div')
  walkSectionHdr.className = 'char-details-section-hdr'
  walkSectionHdr.textContent = 'Walk Cycle'
  walkSection.appendChild(walkSectionHdr)

  const walkControls = document.createElement('div')
  walkControls.className = 'char-details-walk-controls'

  const gaitLabel = document.createElement('label')
  gaitLabel.className = 'char-details-gait-label'
  gaitLabel.textContent = 'Gait: '
  const gaitSel = document.createElement('select')
  gaitSel.className = 'char-details-gait-select'
  for (const g of GAIT_STYLES) {
    const opt = document.createElement('option')
    opt.value = g
    opt.textContent = g.charAt(0).toUpperCase() + g.slice(1)
    gaitSel.appendChild(opt)
  }
  gaitLabel.appendChild(gaitSel)
  walkControls.appendChild(gaitLabel)

  const renderBtn = document.createElement('button')
  renderBtn.className = 'char-details-btn char-details-btn--render'
  renderBtn.textContent = 'Render Walk Cycle'
  if (!headExists()) {
    renderBtn.disabled = true
    renderBtn.title = 'Generate head and required parts first'
  }
  walkControls.appendChild(renderBtn)
  const walkErrDiv = document.createElement('div')
  walkErrDiv.className = 'char-details-walk-err'
  walkControls.appendChild(walkErrDiv)
  walkSection.appendChild(walkControls)

  const walkPreview = document.createElement('div')
  walkPreview.className = 'char-details-walk-preview'
  const existingSheet = byRole.get('walk_sheet')
  if (existingSheet) {
    const img = document.createElement('img')
    img.src = api.assetFileUrl(projectSlug, existingSheet.id)
    img.className = 'char-details-walk-sheet'
    walkPreview.appendChild(img)
  } else {
    walkPreview.classList.add('char-details-walk-preview--empty')
    walkPreview.textContent = 'No walk cycle rendered yet.'
  }
  walkSection.appendChild(walkPreview)

  renderBtn.addEventListener('click', async () => {
    renderBtn.disabled = true
    renderBtn.textContent = 'Rendering...'
    try {
      const result = await api.renderWalk(projectSlug, entitySlug, gaitSel.value as GaitStyle)
      byRole.set('walk_sheet', result)
      walkPreview.innerHTML = ''
      walkPreview.classList.remove('char-details-walk-preview--empty')
      const img = document.createElement('img')
      img.src = api.assetFileUrl(projectSlug, result.id)
      img.className = 'char-details-walk-sheet'
      walkPreview.appendChild(img)
    } catch (e: any) {
      console.error('render-walk failed:', e)
      renderBtn.textContent = 'Error'
      walkErrDiv.textContent = e?.message ?? 'Render failed'
      setTimeout(() => {
        renderBtn.disabled = false
        renderBtn.textContent = 'Render Walk Cycle'
        walkErrDiv.textContent = ''
      }, 5000)
      return
    }
    renderBtn.disabled = false
    renderBtn.textContent = 'Render Walk Cycle'
  })

  body.appendChild(walkSection)
  modal.appendChild(body)
  overlay.appendChild(modal)
  document.body.appendChild(overlay)
}
