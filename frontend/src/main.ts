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
  const layoutEl = document.createElement('div')
  layoutEl.id = 'layout-root'
  app.appendChild(layoutEl)
  initLayout(layoutEl)
}

boot()
