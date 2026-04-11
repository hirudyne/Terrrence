// Shared mutable app state - simple observable pattern, no framework.

export interface AppState {
  label: string | null          // logged-in key label, null = not logged in
  projectSlug: string | null    // active project
  projectName: string | null
  activeEntitySlug: string | null
  previewEntitySlug: string | null
}

type Listener = (state: AppState) => void

const _state: AppState = {
  label: null,
  projectSlug: null,
  projectName: null,
  activeEntitySlug: null,
  previewEntitySlug: null,
}

const _listeners: Set<Listener> = new Set()

export function getState(): Readonly<AppState> {
  return _state
}

export function setState(patch: Partial<AppState>): void {
  Object.assign(_state, patch)
  _listeners.forEach(fn => fn({ ..._state }))
}

export function subscribe(fn: Listener): () => void {
  _listeners.add(fn)
  return () => _listeners.delete(fn)
}
