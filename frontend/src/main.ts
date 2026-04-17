import { api } from './api'
import { setState } from './state'
import { showLogin } from './login'
import { initLayout } from './layout'
import './style.css'

async function boot() {
  const app = document.getElementById('app')!

  // Try to resume an existing session
  try {
    const { label } = await api.whoami()
    setState({ label })
    launch(app)
  } catch (_) {
    const loginEl = showLogin(() => {
      loginEl.remove()
      launch(app)
    })
    app.appendChild(loginEl)
  }
}

function launch(app: HTMLElement) {
  app.innerHTML = ''
  // Pass #app (position:fixed; inset:0) directly to GL.
  // GL reads offsetWidth/offsetHeight from its container element; a child div
  // with position:absolute inside a fixed parent can return stale dims on
  // mobile portrait/landscape rotation. The fixed element itself is reliable.
  initLayout(app)
}

boot()
