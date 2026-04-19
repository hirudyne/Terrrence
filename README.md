# Terrrence

An information management and rapid prototyping system for adventure games. All three Rs are intentional.

Terrrence is a self-hosted web application for writer-developers who need to organise narrative structures, characters, locations, items, and events without touching a programming language. The entire authoring workflow happens in prose.

---

## Concept

Entities in a game world are created and cross-referenced by typing them inline in a text editor using token syntax:

| Token | Type | Colour |
|---|---|---|
| `@@Display Name@@` | Location | blue |
| `##Display Name##` | Character | orange |
| `~~Display Name~~` | Item | teal |
| `??Display Name??` | Chapter | purple |
| `!!trigger!!effect!!` | Event | yellow |
| `""Display Name""` | Conversation | pink |
| `%%Display Name%%` | Spot | green |

Typing `##Derek##` and pressing Tab creates a stub character entity if one does not exist, opens it in the preview pane, and adds it to the reference graph. Existing entities autocomplete as you type. The reference graph is rebuilt on every save.

Renaming an entity cascades the new display name into all inline token references across every file in the project.

---

## Architecture

**Backend:** Python 3.11, FastAPI, Uvicorn

**Frontend:** TypeScript, Vite, Golden Layout 2, CodeMirror 6, Yjs

**Database:** PostgreSQL (psycopg2). The schema is in `server/schema_postgres.sql`. A SQLite schema (`server/schema.sql`) is retained for reference but is not used at runtime.

**Persistence model:** Each entity is a Markdown file with YAML frontmatter:
```
projects/<project_slug>/content/<entity_slug>.md
```
The database is a **rebuildable index** - wiping it and rescanning the project tree must reproduce all content-derived rows. Markdown files on disk are the source of truth.

**Collaboration:** Yjs CRDT over WebSocket (custom implementation in `app.py`), with HTTP debounce as the reliable save path. Yjs state is in-memory only; users mid-session must reload after a server restart.

**Auth:** API key only. Keys are argon2-hashed at rest; plaintext is shown once at mint time. Sessions are HTTP-only, SameSite=Strict cookies with no Max-Age (tab-close clears them).

---

## Features

### Entity types

| Type | Notes |
|---|---|
| `game` | One per project, auto-created, cannot be deleted. Holds top-level narrative overview and `art_style`. |
| `chapter` | Parented under game. Slug derived as `C<N>` from "Chapter N - ..." naming. |
| `location` | Flat. Carries `map_x`/`map_y` for world map placement and `connections` for adjacency graph. |
| `character` | Flat. Carries `physical_appearance`, `voice_description`, `start_location`. |
| `item` | Flat. Carries `start_location`. |
| `event` | Parented under chapter. Created inline inside chapter documents only. |
| `conversation` | Parented under character. Body is structured JSON (greetings + recursive menu tree). |
| `spot` | Parented under location. Named interactive points within a scene. |

### Navigator

Three-pane Golden Layout UI:

- **Left - Navigator:** tree view (sections independently collapsible/maximisable) or tab view. World map overlay for locations; spot map overlay per location item. Backlinks displayed in preview pane.
- **Centre - Editor:** CodeMirror 6 with token syntax highlighting and autocomplete. Conversation entities open a dedicated structured editor instead of CodeMirror.
- **Right - Preview:** rendered body with clickable token links. Tag chips. Asset panel (upload, generate, attach). Character settings (appearance, voice recorder, character asset modal). Location settings (scene image selector). Start location fields for characters and items.

### Image generation

Requires an xAI API key. Art style is read from the game entity's `art_style` frontmatter field.

- Locations/characters/items: scene image, portrait, or sprite via `/v1/images/generations`
- Character facings (back/left/right): conditioned on portrait via `/v1/images/edits`
- Walk cycle frames: 8 frames per facing, each conditioned on portrait

### Voice synthesis

Requires a locally hosted Parler TTS service. Characters can have a registered WAV voice reference. Lines in conversations can be synthesised or recorded directly from the browser microphone. Recorded and synthesised audio can be post-processed with DeepFilterNet.

### World map

Full-screen overlay for placing and connecting locations on a canvas. Location cards are draggable. Connections are drawn by dragging from a card's border zone. Connection IDs are `slugA__slugB` (alpha-sorted, with `__2`, `__3` suffixes for multiple connections between the same pair).

### Spot map

Per-location overlay backed by a scene image. Spots, characters, and items are placed as cards on separate toggleable layers. Spots can be assigned to world-map connections to act as player-facing exits (scene transitions).

### Rename cascade

Renaming an entity derives a new slug, renames the `.md` file, updates the DB, and rewrites all inline token references across every file in the project.

---

## Setup

### Requirements

- Python 3.11+
- Node 18+
- PostgreSQL (any recent version)
- Python packages: `fastapi uvicorn[standard] psycopg2-binary httpx watchdog python-frontmatter argon2-cffi python-multipart aiofiles y-py`

### Database

```sh
psql -U postgres -c "CREATE USER terrrence_user WITH PASSWORD 'yourpassword';"
psql -U postgres -c "CREATE DATABASE terrrence_db OWNER terrrence_user;"
psql -U terrrence_user -d terrrence_db -f server/schema_postgres.sql
```

### Configuration

Create a `.secrets` file alongside the server (keep out of version control):

```
XAI_API_KEY=...        # optional, for image generation
PG_HOST=localhost
PG_PORT=5432
PG_DBNAME=terrrence_db
PG_USER=terrrence_user
PG_PASSWORD=yourpassword
```

Set `TERRRENCE_INSECURE_COOKIES=1` in your environment if running without TLS (development only).

### First run

```sh
# Install Python deps
pip install fastapi "uvicorn[standard]" psycopg2-binary httpx watchdog python-frontmatter argon2-cffi python-multipart aiofiles y-py

# Build frontend
cd frontend && npm install && npm run build && cd ..

# Mint an API key
python3 server/mint_key.py --label owner
# Copy the printed key - it will not be shown again

# Start the server
cd server && uvicorn app:app --host 0.0.0.0 --port 8000
```

The server listens on `0.0.0.0:8000`. Place it behind a TLS-terminating reverse proxy before exposing publicly.

### Optional services

| Service | Default address | Purpose |
|---|---|---|
| Parler TTS (voice clone) | `http://localhost:8001` | Line synthesis via named voice |
| DeepFilterNet | `http://localhost:8002` | Audio noise reduction |

These are only needed for voice features. The addresses are configured as `VOXPOP_URL` in `app.py`.

---

## Repository layout

```
server/
  app.py                All backend routes and logic
  mint_key.py           CLI key minter
  schema_postgres.sql   Full PostgreSQL DDL
  schema.sql            SQLite DDL (reference only)
frontend/
  src/
    api.ts              Typed fetch wrapper for all API methods
    audio-utils.ts      Browser mic recording and WAV transcode utility
    character-details.ts  Character asset modal (facings + walk cycle)
    conversation-types.ts ConvData schema types and ID generation
    editor.ts           CodeMirror 6 factory, Yjs binding, token highlighting, autocomplete
    layout.ts           Golden Layout 2 three-pane config
    login.ts            Login screen
    main.ts             Boot: whoami or login, then initLayout
    pane-conversation.ts  Conversation structured editor
    pane-editor.ts      Centre pane: tab bar and editor mounting
    pane-nav.ts         Left pane: tree/tab views, modals, entity management
    pane-preview.ts     Right pane: rendered preview, tags, assets, settings
    spot-map.ts         Spot map overlay for locations
    state.ts            Observable global state (no framework)
    style.css           Dark theme, all component styles
    world-map.ts        World map overlay for location placement
  index.html
  package.json
  tsconfig.json
  vite.config.ts
```

---

## Entity file format

```markdown
---
display_name: Sholver's Mum
slug: sholver_s_mum
type: character
physical_appearance: "tall, weathered skin..."
voice_description: "gruff older female..."
start_location:
  location: corner_shop
  x: 0.4
  y: 0.6
---

Body text with ##inline## @@token@@ ~~references~~.
```

Conversation entity bodies contain structured JSON instead of prose. Schema defined in `conversation-types.ts`.

---

## Slug derivation

- Chapters: `"Chapter 3 - ..."` -> `C3`
- All others: unicode normalise -> ASCII -> lowercase -> collapse non-alphanumeric runs to `_` -> truncate 64 chars
- `deriveSlug()` in `pane-nav.ts` must be kept in sync with `_derive_slug()` in `app.py`

---

## License

MIT
