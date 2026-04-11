# Terrrence

An information management and rapid prototyping system for adventure games. All three Rs are intentional.

Terrrence is a self-hosted web application for writer-developers who need to organise narrative structures, characters, locations, items, and events without touching a programming language. The entire authoring workflow happens in prose.

---

## Concept

The core idea is that entities in a game world are created and cross-referenced by typing them inline in a text editor, using prefix tokens borrowed from collaboration platforms:

| Token | Type |
|---|---|
| `@slug` | Location |
| `#slug` | Character |
| `~slug~` | Item |
| `??slug??` | Chapter |
| `!!trigger prose!!effect prose!!` | Event |

Typing `#derek ` in the editor immediately creates a stub character entity called `derek` if one does not already exist, and opens it in the reference preview pane. Existing entities are autocompleted as you type. The reference graph is rebuilt automatically on every save.

---

## Architecture

- **Backend:** Python 3.11, FastAPI, Uvicorn, SQLite (WAL mode)
- **Frontend:** TypeScript, Vite, Golden Layout 2, CodeMirror 6, Yjs
- **Persistence:** Each entity is a Markdown file with YAML frontmatter under `/workspace/projects/<project>/content/`. A SQLite index at `/workspace/data/terrrence.db` holds the reference graph, sessions, tags, and asset associations. The index is rebuildable from disk at any time.
- **Collaboration:** Yjs CRDT over WebSocket (`ypy-websocket`), with HTTP debounce as a fallback save path.
- **Auth:** API key only. Keys are argon2-hashed at rest; plaintext is shown once at mint time. Sessions are HTTP-only, SameSite=Strict cookies with no expiry (tab-close clears them).
- **Deployment:** Single Docker container. A supervisor loop in `start.sh` keeps Uvicorn running across crashes. Persistent state lives entirely under the `/workspace` bind mount.

---

## Features

### Projects
- Create and switch between projects from the navigator
- Each project is independently version-controlled with its own `git` repository under `/workspace/projects/<slug>/`
- Projects can be shared with other API keys, granting full access

### Entities
Six types: `game`, `chapter`, `location`, `character`, `item`, `event`

- One `game` entity per project, created automatically, cannot be deleted - holds the top-level narrative overview
- `chapter` entities are parented under the game entity in the navigator tree
- All other entities are flat, grouped by type in tree or tab view
- Inline token typing auto-creates stub entities on space/punctuation
- Entity slugs are durable filesystem handles; display names are freely editable
- Full CRUD via the UI; the game entity is protected from deletion

### Editor
- CodeMirror 6 with syntax highlighting for all five token types (each a distinct colour)
- Type-aware autocomplete: `@` offers locations, `#` offers characters, `~` offers items, `??` offers chapters
- Saves on every whitespace insertion and after 1 second of inactivity
- Tabs for multiple open entities; per-tab close

### Reference Preview
- The most recently typed or clicked entity token opens automatically in the right pane
- Displays rendered body text with clickable token links for navigation
- Tag chips: add/remove freeform tags inline
- Asset panel: upload and attach images, audio, or other files; images render as thumbnails, audio renders as a player

### Assets
- Upload files per project; attach to any entity with an optional role label (e.g. `sprite`, `voice`)
- Assets stored under `/workspace/projects/<slug>/assets/`
- Served directly by the backend

### Tags
- Flat, per-project, multi-valued
- Added and removed inline in the preview pane
- Stored by entity ID, so they survive display name renames

### Navigator
- Tree view: game and chapters at top, then locations, characters, items, events - each with item count
- Tab view: per-type flat lists with a type selector
- Click any entity to open it in the editor; use `>` to open in preview instead
- Delete any non-game entity with confirmation

---

## Setup

### Requirements
- Docker
- The image defined in `Dockerfile` (debian:bookworm-slim + Python 3.11 + Node 18 + the packages listed in the Dockerfile)

### First run
```sh
# Build frontend
cd frontend && npm install && npm run build && cd ..

# Mint an API key
python3 server/mint_key.py --label owner
# Copy the printed key - it will not be shown again

# Start the server (supervisor loop, restarts on crash)
./start.sh
```

The server listens on `0.0.0.0:8000`. Place it behind a TLS-terminating reverse proxy (e.g. Cloudflare Tunnel + nginx) before exposing publicly.

### Environment variables
| Variable | Default | Purpose |
|---|---|---|
| `TERRRENCE_DB` | `/workspace/data/terrrence.db` | Main index DB path |
| `TERRRENCE_YJS_STORE` | `/workspace/data/terrrence_yjs_updates.db` | Yjs update store path |
| `TERRRENCE_PROJECTS` | `/workspace/projects` | Project root |
| `TERRRENCE_INSECURE_COOKIES` | `0` | Set to `1` to allow session cookies over plain HTTP (dev only) |

> **Note:** `start.sh` sets `TERRRENCE_INSECURE_COOKIES=1` by default for container-local development. Remove this before any public deployment.

---

## Repository layout

```
/
- Dockerfile          Container image definition
- start.sh            PID 1 supervisor loop
- server/
  - app.py            All backend routes and logic
  - mint_key.py       CLI key minter
  - schema.sql        Main DB schema
  - schema_yjs.sql    Yjs state DB schema (legacy; active store is managed by ypy-websocket)
- frontend/
  - src/              TypeScript source
  - index.html
  - package.json
  - vite.config.ts
- fail2ban/           fail2ban filter and jail config (for host-side deployment)
```

---

## License

MIT
