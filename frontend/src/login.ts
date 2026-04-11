import { api } from './api'
import { setState } from './state'

export function showLogin(onSuccess: () => void): HTMLElement {
  const wrap = document.createElement('div')
  wrap.id = 'login-screen'
  wrap.innerHTML = `
    <div class="login-box">
      <h1>Terrrence</h1>
      <p>Paste your API key to continue.</p>
      <input id="login-key-input" type="password" placeholder="API key" autocomplete="off" />
      <button id="login-btn">Login</button>
      <div id="login-error" class="login-error"></div>
    </div>
  `

  const input = wrap.querySelector<HTMLInputElement>('#login-key-input')!
  const btn = wrap.querySelector<HTMLButtonElement>('#login-btn')!
  const errEl = wrap.querySelector<HTMLElement>('#login-error')!

  const attempt = async () => {
    const key = input.value.trim()
    if (!key) return
    btn.disabled = true
    errEl.textContent = ''
    try {
      await api.login(key)
      const { label } = await api.whoami()
      setState({ label })
      onSuccess()
    } catch (e: any) {
      errEl.textContent = e.message ?? 'Login failed'
      btn.disabled = false
    }
  }

  btn.onclick = attempt
  input.onkeydown = (e) => { if (e.key === 'Enter') attempt() }

  return wrap
}
