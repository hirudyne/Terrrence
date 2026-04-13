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

  // Recalculate pane sizes whenever the app container changes size
  // (covers window resize, devtools open/close, panel drags)
  const ro = new ResizeObserver((entries) => {
    const e = entries[0].contentRect
    layout.updateSize(e.width, e.height)
  })
  ro.observe(appEl)
}
