// Thin fetch wrapper - all paths relative so the Vite proxy handles dev vs prod.

export interface Project {
  slug: string
  display_name: string
  owned: boolean
}

export interface Entity {
  slug: string
  type: string
  display_name: string
  parent_slug: string | null
}

export interface EntityDetail extends Entity {
  body: string
  meta: Record<string, unknown>
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw Object.assign(new Error(err.detail ?? res.statusText), { status: res.status })
  }
  return res.json() as Promise<T>
}

export interface Asset {
  id: number
  rel_path: string
  mime: string
  bytes: number
  role: string | null
}

export const api = {
  health: () => req<{ ok: boolean }>('GET', '/health'),
  version: () => req<{ version: string }>('GET', '/version'),
  login: (api_key: string) => req<{ ok: boolean }>('POST', '/login', { api_key }),
  logout: () => req<{ ok: boolean }>('POST', '/logout'),
  whoami: () => req<{ label: string }>('GET', '/whoami'),

  listProjects: () => req<Project[]>('GET', '/projects'),
  createProject: (slug: string, display_name: string) =>
    req<Project>('POST', '/projects', { slug, display_name }),
  shareProject: (slug: string, api_key_label: string) =>
    req<{ ok: boolean }>('POST', `/projects/${slug}/share`, { api_key_label }),

  listEntities: (project: string, type?: string) =>
    req<Entity[]>('GET', `/projects/${project}/entities${type ? `?type=${type}` : ''}`),
  getEntity: (project: string, slug: string) =>
    req<EntityDetail>('GET', `/projects/${project}/entities/${slug}`),
  createEntity: (project: string, data: { slug: string; display_name: string; type: string; body?: string; parent_slug?: string }) =>
    req<Entity>('POST', `/projects/${project}/entities`, data),
  deleteEntity: (project: string, slug: string) =>
    req<void>('DELETE', `/projects/${project}/entities/${slug}`),
  ensureEntity: (project: string, display_name: string, type: string) =>
    req<Entity & { created: boolean }>('POST', `/projects/${project}/entities/ensure`, { display_name, type }),

  listAssets: (project: string) =>
    req<Asset[]>('GET', `/projects/${project}/assets`),
  listEntityAssets: (project: string, entity: string) =>
    req<Asset[]>('GET', `/projects/${project}/entities/${entity}/assets`),
  associateAsset: (project: string, entity: string, asset_id: number, role?: string) =>
    req<{ ok: boolean }>('POST', `/projects/${project}/entities/${entity}/assets`, { asset_id, role }),
  disassociateAsset: (project: string, entity: string, asset_id: number) =>
    req<void>('DELETE', `/projects/${project}/entities/${entity}/assets/${asset_id}`),
  assetFileUrl: (project: string, asset_id: number) =>
    `/projects/${project}/assets/${asset_id}/file`,

  listTags: (project: string) =>
    req<{id:number;name:string}[]>('GET', `/projects/${project}/tags`),
  listEntityTags: (project: string, entity: string) =>
    req<{id:number;name:string}[]>('GET', `/projects/${project}/entities/${entity}/tags`),
  addEntityTag: (project: string, entity: string, name: string) =>
    req<{id:number;name:string}>('POST', `/projects/${project}/entities/${entity}/tags`, { name }),
  removeEntityTag: (project: string, entity: string, tag_name: string) =>
    req<void>('DELETE', `/projects/${project}/entities/${entity}/tags/${encodeURIComponent(tag_name)}`),
  updateEntity: (project: string, slug: string, data: { display_name?: string; body?: string }) =>
    req<Entity>('PATCH', `/projects/${project}/entities/${slug}`, data),
}
