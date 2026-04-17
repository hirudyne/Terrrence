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

  // Set flag BEFORE init so intent is clear. GL checks it lazily at each
  // resize event (not during init), so post-init also works - but pre-init
  // documents that we own this container, not document.body.
  ;(layout as any).resizeWithContainerAutomatically = true
  layout.loadLayout(LAYOUT_CONFIG)
  layout.init()

  // GL's internal ResizeObserver fires handleContainerResize() -> processResizeWithDebounce()
  // -> updateSizeFromContainer() after 100ms debounce. That reads offsetWidth/offsetHeight
  // from the container and calls setSize(). This should cover all window/devtools resizes.
  //
  // visualViewport fires on Windows too (devtools open/close can trigger it in Chrome).
  // updateSizeFromContainer() is the correct call - it re-reads container dims.
  // updateRootSize() only redistributes already-stored dims, wrong for container resize.
  const _glSync = () => {
    const ow = appEl.offsetWidth
    const oh = appEl.offsetHeight
    const { width: bw, height: bh } = appEl.getBoundingClientRect()
    console.debug('[gl sync] offset:', ow, oh, '| bcr:', Math.round(bw), Math.round(bh))
    ;(layout as any).updateSizeFromContainer()
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', _glSync)
  }
  // Belt-and-braces for devtools panel resize on PC which may not fire visualViewport.
  window.addEventListener('resize', _glSync)
}
