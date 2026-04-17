// Golden Layout 2 - three-pane layout: nav (1/4), editor (1/2), preview (1/4).

import { GoldenLayout, LayoutConfig } from 'golden-layout'
import { NavPane } from './pane-nav'
import { EditorPane } from './pane-editor'
import { PreviewPane } from './pane-preview'

const LAYOUT_CONFIG: LayoutConfig = {
  root: {
    type: 'row',
    content: [
      {
        type: 'component',
        componentType: 'nav',
        title: 'Navigator',
        width: 20,
        isClosable: false,
      },
      {
        type: 'component',
        componentType: 'editor',
        title: 'Editor',
        width: 55,
        isClosable: false,
      },
      {
        type: 'component',
        componentType: 'preview',
        title: 'Preview',
        width: 25,
        isClosable: false,
      },
    ],
  },
}

export function initLayout(appEl: HTMLElement): void {
  const layout = new GoldenLayout(appEl)

  layout.registerComponentFactoryFunction('nav', (container) => {
    const nav = new NavPane(container.element as HTMLElement)
    // Expose globally so editor can optimistically add entities
    ;(window as any)._terrrenceNav = nav
  })

  layout.registerComponentFactoryFunction('editor', (container) => {
    new EditorPane(container.element as HTMLElement)
  })

  layout.registerComponentFactoryFunction('preview', (container) => {
    new PreviewPane(container.element as HTMLElement)
  })

  layout.loadLayout(LAYOUT_CONFIG)
  layout.init()

  const _sync = () => {
    // updateSizeFromContainer() reads from the container element directly,
    // bypassing GL's own stale row/column inline styles that cause the
    // landscape->portrait resize to silently use old dimensions.
    // It is marked @internal but is the only reliable path.
    const gl = layout as unknown as Record<string, () => void>
    gl['updateSizeFromContainer']()
    requestAnimationFrame(() => gl['updateSizeFromContainer']())
  }

  requestAnimationFrame(_sync)

  let _t1: ReturnType<typeof setTimeout> | null = null
  let _t2: ReturnType<typeof setTimeout> | null = null
  const _onResize = () => {
    if (_t1) clearTimeout(_t1)
    if (_t2) clearTimeout(_t2)
    requestAnimationFrame(_sync)
    _t1 = setTimeout(_sync, 100)
    _t2 = setTimeout(_sync, 600)
  }

  new ResizeObserver(_onResize).observe(appEl)
  window.addEventListener('resize', _onResize)
  if (window.visualViewport) window.visualViewport.addEventListener('resize', _onResize)
}
