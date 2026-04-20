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

**Database:** PostgreSQL (psycopg2). Schema in `server/schema_postgres.sql`.

**Persistence model:** Each entity is a Markdown file with YAML frontmatter at `projects/<project_slug>/content/<entity_slug>.md`. The database is a **rebuildable index** - Markdown files on disk are the source of truth.

**Collaboration:** Yjs CRDT over WebSocket (custom implementation in `app.py`), with HTTP debounce as the reliable save path. Yjs state is in-memory only; users mid-session must reload after a server restart.

**Auth:** API key only. Keys are argon2-hashed at rest; plaintext is shown once at mint time. Sessions are HTTP-only, SameSite=Strict cookies with no Max-Age (tab-close clears them).

---

## Features

### Entity types

| Type | Notes |
|---|---|
| `game` | One per project, auto-created, cannot be deleted. Holds top-level narrative overview and `art_style`. |
| `chapter` | Parented under game. Slug derived as `C<N>` from "Chapter N - ..." naming. |
| `location` | Flat. Carries `map_x`/`map_y` for world map placement, `connections` for adjacency graph, `scene_image` asset ID. |
| `character` | Flat. Carries `physical_appearance`, `voice_description`, `start_location`, `skin_tone`, `gait_style`, `puppet_pivot`, `puppet_max_angle`. |
| `item` | Flat. Carries `start_location`. |
| `event` | Parented under chapter. Created inline inside chapter documents only. |
| `conversation` | Parented under character. Body is structured JSON (greetings + recursive menu tree). |
| `spot` | Parented under location. Named interactive points within a scene. Carries `spot_x`, `spot_y`, `connection_id`. |

### Navigator

Three-pane Golden Layout UI:

- **Left - Navigator:** tree view (sections independently collapsible/maximisable) or tab view. World map overlay for locations; spot map overlay per location item.
- **Centre - Editor:** CodeMirror 6 with token syntax highlighting and autocomplete. Conversation entities open a dedicated structured editor.
- **Right - Preview:** rendered body with clickable token links. Tag chips. Asset panel. Character/location/item settings. Backlinks.

### Image generation

Requires an xAI API key (`XAI_API_KEY` in `.secrets`). Art style read from the game entity's `art_style` frontmatter field.

- Locations, characters, items: scene/portrait/sprite via `/v1/images/generations`
- Character facings (back/left/right): conditioned on portrait via `/v1/images/edits`

### Puppet walk cycle

Character asset modal (accessed via "Character Assets" button in preview pane) generates directional facing images and renders puppet walk cycles without any AI calls:

1. Generate a portrait, then generate directional facings (front/back/left/right) conditioned on it.
2. Hit **Render** on any facing to produce an 8-frame walk cycle as individual RGBA PNGs.
3. The player in the modal animates the frames at a configurable FPS.

**How it works:** rembg removes the background from the facing image (result cached as `facing_{dir}_transparent`). The transparent sprite is then rotated around a configurable pivot point with sinusoidal squash/stretch to simulate a walking bob. Frames are stored as `walk_puppet_{facing}_frame_1-8`.

**Per-character controls** (in character preview pane, Puppet Walk section):
- `Gait`: shuffle / stride / jog / waddle / custom. Controls the angle table and squash parameters.
- `Pivot (0-1)`: vertical position of rotation pivot as a fraction of sprite height. Default 0.667. Only editable in custom mode.
- `Max angle (deg)`: overrides the gait's default angle range. Only editable in custom mode.

Front/back facings automatically use half the angle of left/right for a more restrained wobble.

### Voice synthesis

Requires a locally hosted Parler TTS service. Characters can have a registered WAV voice reference. Lines in conversations can be synthesised or recorded from the browser microphone. Audio can be post-processed with DeepFilterNet.

### World map

Full-screen overlay for placing and connecting locations on a canvas. Connection IDs are `slugA__slugB` (alpha-sorted, `__2`/`__3` suffixes for multiples).

### Spot map

Per-location overlay backed by a scene image. Spots, characters, and items placed as cards on toggleable layers. Spots can be assigned to world-map connections to act as player-facing exits.

### Rename cascade

Renaming an entity derives a new slug, renames the `.md` file, updates the DB, and rewrites all inline token references across every file in the project.

---

## Setup

### Requirements

- Python 3.11+, Node 18+, PostgreSQL
- Python packages: `fastapi "uvicorn[standard]" psycopg2-binary httpx watchdog python-frontmatter argon2-cffi python-multipart aiofiles y-py Pillow "rembg[cpu]"`

### Database

```sh
psql -U postgres -c "CREATE USER terrrence_user WITH PASSWORD 'yourpassword';"
psql -U postgres -c "CREATE DATABASE terrrence_db OWNER terrrence_user;"
psql -U terrrence_user -d terrrence_db -f server/schema_postgres.sql
```

### Configuration

Create `.secrets` alongside the server (gitignored):

```
XAI_API_KEY=...
PG_HOST=localhost
PG_PORT=5432
PG_DBNAME=terrrence_db
PG_USER=terrrence_user
PG_PASSWORD=yourpassword
```

Set `TERRRENCE_INSECURE_COOKIES=1` in environment if running without TLS (development only).

### First run

```sh
pip install fastapi "uvicorn[standard]" psycopg2-binary httpx watchdog python-frontmatter \
    argon2-cffi python-multipart aiofiles y-py Pillow "rembg[cpu]"
cd frontend && npm install && npm run build && cd ..
python3 server/mint_key.py --label owner
cd server && uvicorn app:app --host 0.0.0.0 --port 8000
```

### Optional services

| Service | Default address | Purpose |
|---|---|---|
| Parler TTS (voice clone) | `http://purpose-voxpop:8001` | Line synthesis |
| DeepFilterNet | `http://purpose-voxpop:8002` | Audio noise reduction |

---

## Repository layout

```
server/
  app.py                All backend routes and logic (~2600 lines)
  mint_key.py           CLI key minter
  schema_postgres.sql   Full PostgreSQL DDL
frontend/
  src/
    api.ts              Typed fetch wrapper for all API methods
    audio-utils.ts      Browser mic recording and WAV transcode
    character-details.ts  Character asset modal (facings + puppet walk cycle player)
    conversation-types.ts ConvData schema types and ID generation
    editor.ts           CodeMirror 6 factory, Yjs binding, token highlighting, autocomplete
    layout.ts           Golden Layout 2 three-pane config
    login.ts            Login screen
    main.ts             Boot sequence
    pane-conversation.ts  Conversation structured editor
    pane-editor.ts      Centre pane: tab bar and editor mounting
    pane-nav.ts         Left pane: tree/tab views, modals, entity management
    pane-preview.ts     Right pane: preview, tags, assets, character/location settings
    spot-map.ts         Spot map overlay
    state.ts            Observable global state
    style.css           Dark theme, all component styles
    world-map.ts        World map overlay
```

---

## Entity file format

```markdown
---
display_name: Sholver's Mum
slug: sholver_s_mum
type: character
physical_appearance: "little old lady..."
voice_description: "northern working class old lady..."
skin_tone: "#c4956a"
gait_style: shuffle
start_location:
  location: corner_shop
  x: 0.4
  y: 0.6
---

Body text with ##inline## @@token@@ ~~references~~.
```

Conversation entity bodies contain structured JSON. Schema defined in `conversation-types.ts`.

---

## Slug derivation

- Chapters: `"Chapter 3 - ..."` -> `C3`
- Others: unicode normalise -> ASCII -> lowercase -> collapse non-alphanumeric to `_` -> truncate 64 chars
- `deriveSlug()` in `pane-nav.ts` must stay in sync with `_derive_slug()` in `app.py`

---

## Known gaps and deferred work

- Slug rename cascade does not yet rewrite body text of conversation JSON
- Backlinks endpoint exists but no nav UI for it
- Git commits per save (repos initialised per project, never committed; `user.name`/`user.email` not set)
- fail2ban config exists at `fail2ban/` but is not active
- Key management is CLI only (`mint_key.py`)
- Share panel requires project modal to be opened once per session for ownership detection
- Playable scene preview (DSL design settled, not implemented)
- Walk cycle frame count hardcoded at 8 (configurable via `puppet_frame_count` frontmatter is a planned trivial addition)
- Frame-locked movement: movement system should dynamically adjust animation FPS so motion always ends on frame 0; feasible once scene preview is built
- Intercardinal facings (NW/NE etc.) are not generated; optical flow interpolation between cardinals is not recommended due to face morphing artefacts
- `TERRRENCE_INSECURE_COOKIES=1` in `start.sh` must be removed before public deployment without edge TLS
