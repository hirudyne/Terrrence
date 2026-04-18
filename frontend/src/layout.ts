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
  // `new GoldenLayout(containerElement)` auto-calls init() when called with a
  // single container argument (not the deprecated config-object form).
  // init() attaches GL's internal ResizeObserver to the container element.
  //
  // Flag must be set BEFORE the observer fires for the first real event.
  // We set it between construction and loadLayout, which runs synchronously
  // before any user interaction can trigger resize events.
  const layout = new GoldenLayout(appEl)
  ;(layout as any).resizeWithContainerAutomatically = true

  layout.registerComponentFactoryFunction('nav', (container) => {
    const nav = new NavPane(container.element as HTMLElement)
    ;(window as any)._terrrenceNav = nav
  })
  layout.registerComponentFactoryFunction('editor', (container) => {
    new EditorPane(container.element as HTMLElement)
  })
  layout.registerComponentFactoryFunction('preview', (container) => {
    new PreviewPane(container.element as HTMLElement)
  })

  // loadLayout is the correct post-auto-init path to install content.
  // Do NOT call init() again - it creates a second GroundItem and breaks sizing.
  layout.loadLayout(LAYOUT_CONFIG)
}
