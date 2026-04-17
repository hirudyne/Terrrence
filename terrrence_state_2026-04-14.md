# Terrrence - Comprehensive State Document

**Generated:** 2026-04-14
**Version:** 0.7.2
**Repository:** https://github.com/hirudyne/Terrrence
**Live URL:** https://terrrence.hirudyne.net

---

## 0. Instructions for a Successor Instance

You are continuing work on **Terrrence**, an information management and rapid prototyping system for adventure games. All three Rs are intentional.

**Standing instructions (highest priority - override everything else):**

- Use only the `terrrence` MCP tool for all container interaction. Never use `infra` or any other tool.
- Persistent state lives under `/workspace` (bind mount). The container filesystem is otherwise ephemeral.
- Do not create documentation unless asked. When asked, only at the requested location with requested contents.
- Treat questions as passive information requests unless explicitly commanded.
- "See if", "check that", "look into" = report back, do not act.
- On surprising circumstances: stop, report, wait for explicit approval.
- Do not interpret unclear or non-committal responses as approval.
- No em-dashes in code or programmatic output.
- Bump `VERSION` and rebuild frontend as part of every change session before final commit (use `bump_version.sh [major|minor|patch]`).
- After every deployment: restart uvicorn (kill the uvicorn PID, supervisor restarts it), rebuild frontend if changed, purge CF cache.
- Use `deploy.sh` for all deployments - do not run deployment steps manually.

**Workflow for making changes:**

```sh
# 1. Make backend changes to /workspace/server/app.py
# 2. Verify: cd /workspace/server && python3 -c "import app; print('ok')"
# 3. Make frontend changes to /workspace/frontend/src/
# 4. Deploy: cd /workspace && bash deploy.sh patch "description"
```

**deploy.sh usage:**
```sh
bash /workspace/deploy.sh [major|minor|patch] "commit message"
```

**Manual steps if deploy.sh fails partway:**
```sh
# Purge CF cache
python3 -c "
import urllib.request, json
req = urllib.request.Request(
  'http://172.20.0.1:7000/cf/purge',
  data=json.dumps({'prefixes':['terrrence.hirudyne.net']}).encode(),
  headers={'X-Gateway-Token': open('/workspace/.gateway-token').read().strip(), 'Content-Type': 'application/json'},
  method='POST'
)
print(urllib.request.urlopen(req).read())
"
# Commit and push
cd /workspace && git add -A && git commit -m "vX.Y.Z - description" && git push origin main
```

---

## 1. Operating Environment

*(Unchanged from previous document - see v0.1.49 state doc for container/server/filesystem details)*

External services now in use:

| Service | Address | Purpose |
|---|---|---|
| voxpop TTS (Parler) | `http://purpose-voxpop:8000` | Legacy - no longer used |
| voxpop TTS (voice clone) | `http://purpose-voxpop:8001` | Line synthesis via named voice |
| Resemble Enhance | `http://purpose-voxpop:8002` | Audio enhancement - currently broken server-side, deferred |

---

## 2. Filesystem Layout Changes

New frontend source files added since v0.1.49:

```
frontend/src/
  audio-utils.ts          browser mic recording + WAV transcode utility
  conversation-types.ts   ConvData schema types, ID generation, JSON serialise/parse
  pane-conversation.ts    conversation entity editor UI
  world-map.ts            world map overlay for location placement
```

---

## 3. Stack Changes

### 3.1 Backend

`app.py` is now ~1918 lines. New packages in use: `httpx` (already present) for voxpop/enhance relay.

`VOXPOP_URL = "http://purpose-voxpop:8001"` - voice clone service.

### 3.2 Frontend

New shared utility: `audio-utils.ts` exports `blobToWav(blob)` and `startRecording()`.

- `blobToWav`: decodes any browser audio blob via Web Audio API, re-encodes as 16-bit mono PCM WAV (44100 Hz). Used before any audio upload to ensure format compatibility.
- `startRecording`: wraps `getUserMedia` + `MediaRecorder`, returns `{ stop: () => Promise<Blob> }`.

---

## 4. New and Changed API Endpoints

### Entity Rename
```
POST /projects/{p}/entities/{s}/rename
Body: { display_name: string }
Returns: { slug, display_name, type }
```
Derives new slug, renames .md file, updates DB, cascades slug changes into `connections` frontmatter of all other location files. **Chapters and game entities**: display_name updated, slug unchanged. Returns 409 on slug collision.

### PATCH entity meta - empty string deletion
`PATCH /projects/{p}/entities/{s}` with `meta: { key: "" }` now **deletes** that key from frontmatter rather than storing an empty string. Used by world map unplace and connection deletion.

### Image prompt (no generation)
```
GET /projects/{p}/entities/{s}/image-prompt
Returns: { prompt: string }
```
Returns the fully assembled image generation prompt (art style + type template + entity body) without calling xAI.

### Voice registration (voxpop 8001)
```
GET  /projects/{p}/voices
POST /projects/{p}/characters/{s}/register-voice   body: raw WAV bytes
DELETE /projects/{p}/characters/{s}/register-voice
```
Relay to voxpop 8001 `/voices/{name}`. Upload uses multipart `file` field. Name = character slug.

### Voice synthesis (voxpop 8001)
```
POST /projects/{p}/entities/{s}/generate-voice
Body: { line_id, line_index, text, speaker_slug }
```
Updated from port 8000 to 8001. Request: `{ voice: speaker_slug, text, format: "wav", style_strength: 1.9 }`. Saves WAV as asset, patches `audio` field on the line in conversation JSON body.

### Line recording (direct, no enhance)
```
POST /projects/{p}/entities/{s}/record-line?line_id=...&line_index=...
Body: raw WAV bytes
Returns: { asset_id, filename }
```
Saves recorded WAV directly as asset (role `"recorded"`), patches `audio` field on the line. No enhancement pipeline.

---

## 5. Data Model Changes

### 5.1 Location frontmatter additions

Locations may now carry:
```yaml
map_x: 0.42       # normalised float 0-1, canvas position
map_y: 0.38
connections:
  - id: slugA__slugB    # alphabetically sorted, double-underscore separator
    to: other_slug
    from_edge: { edge: right, t: 0.5 }   # edge: top/right/bottom/left, t: 0-1 fraction
    to_edge: { edge: left, t: 0.5 }
```

Connection IDs are `slugA__slugB` (alpha sorted). Each location stores its own half. World map deduplicates by ID when rendering lines.

### 5.2 Character frontmatter additions

Characters may now carry:
```yaml
physical_appearance: "tall, weathered skin, grey stubble..."
voice_description: "gruff older male, slow deliberate speech..."
```

These are stored as meta keys via `PATCH entity meta`. `voice_description` is now cosmetic/notes only - voxpop 8001 uses a registered WAV reference, not a text description.

### 5.3 Conversation entity body format

Conversation entities store structured JSON (not prose) as their body:

```json
{
  "greetings": [
    {
      "id": "greet_001",
      "prerequisite": null,
      "lines": [
        { "speaker": "##Sholver##", "text": "Hey up.", "audio": null }
      ]
    }
  ],
  "menu": [
    {
      "id": "opt_001",
      "label": "Who are you?",
      "prerequisite": null,
      "triggers": null,
      "lines": [ { "speaker": "##Sholver##", "text": "Name's Sholver.", "audio": null } ],
      "response_menu": []
    }
  ]
}
```

- `greetings`: ordered list. First with satisfied prerequisite plays once ever, then falls through to menu or terminates.
- `menu`: recursive option tree. `response_menu` is identical in structure to `menu`, arbitrary depth.
- `prerequisite` / `triggers`: bare event slugs or null.
- `speaker`: `##CharacterName##` token - must match a known character.
- `audio`: integer asset ID or null. Set by voxpop synthesis or direct line recording.
- IDs auto-derived from label/type at creation, never regenerated on edit. Duplicates blocked.

---

## 6. Frontend Architecture Changes

### 6.1 Layout resize

`layout.ts` now uses a `ResizeObserver` on the app element instead of `window.addEventListener('resize')`. Calls `layout.updateSize(e.width, e.height)` from `contentRect`. Catches devtools panel open/close and any container size change.

### 6.2 Navigator - World Map mode

Clicking the `@@ locations (N)` header (or its map icon, visible on hover) opens the world map overlay. See section 7.

### 6.3 Editor pane - conversation mode switching

`pane-editor.ts` tracks `tabTypes: Map<slug, type>`. When a conversation entity is opened, `_mountConversationEditor(slug)` is called instead of CodeMirror. A `ConversationEditor` instance is created in a dedicated wrapper div (not `editorArea` itself) and cached in `convEditors: Map<slug, ConversationEditor>`. Closing the tab destroys both the CodeMirror and conv editor entries.

### 6.4 Token stub confirmation

Token auto-stubbing (`ensureEntity`) no longer fires automatically or after a debounce timer. Instead:
- `_pendingToken: { inner, type } | null` is set whenever a completed token is within 2 chars of the cursor.
- A custom keymap (highest priority) intercepts **Tab** and **Enter**: if `_pendingToken` is set, fires `_onTokenComplete` and returns `true` (consuming the keypress without inserting whitespace).
- Moving the cursor away from a token clears `_pendingToken`.

### 6.5 Preview pane changes

**Editable display name**: the `preview-title` span is replaced with a `preview-title-input` text input. On 800ms debounce calls `POST .../rename`. Slug label updates after success. On failure, reverts to previous name.

**Character settings section**: character entities show two additional debounced textarea fields below the body:
- Physical Appearance (`physical_appearance`, 500 chars)
- Voice Description (`voice_description`, 300 chars, cosmetic only)

**Voice Reference recorder**: also in character settings. Record button (requests mic), Stop button, audio preview player, Register/Delete buttons. On register: transcodes to WAV via `blobToWav`, POSTs to `/register-voice`. Status shows registered/not registered state.

**Copy prompt button**: alongside "Generate image" for location/character/item entities. Fetches prompt from `GET .../image-prompt` and writes to clipboard.

### 6.6 Conversation editor (`pane-conversation.ts`)

Single-column scrollable layout (greetings above, menu below). Two-column layout was removed.

**Greetings**: ordered cards with ID badge, prerequisite field (event autocomplete), line sequence.

**Menu**: recursive option cards with label, prerequisite, triggers (event autocomplete), line sequence, collapsible response menu. Depth is unbounded.

**Lines**: each line has:
- Speaker input (`##CharName##` autocomplete from character cache, validation indicator)
- Dialogue textarea (saves without re-render - structural changes only trigger `_render`)
- `▶` play button (shown when `audio !== null`; toggles to `■` while playing)
- `⊕`/`⟳` TTS generate button (disabled with tooltip if speaker/text missing or no voice registered for character)
- `🎙` record button (disabled during active recording shows `⏹`; on stop: transcodes to WAV, POSTs to `/record-line`, saves as asset, shows `▶`)
- TTS progress bar with countdown estimate (based on rolling average of chars/sec from session samples stored in `sessionStorage`)

**Autocomplete**: speaker field uses character cache. Prerequisite/triggers fields use event cache. Both use `input.parentElement` approach - inputs must be appended to DOM before `attachAutocomplete` is called.

**Save behaviour**: `_save()` persists JSON body only. `_render()` is only called for structural mutations (add/remove/reorder items). Field edits (text, speaker, prereq, triggers) call `_save()` directly without re-render.

---

## 7. World Map (`world-map.ts`)

Accessed by clicking the `@@ locations` header in tree view. Opens a full-screen overlay.

**Layout**: narrow left tray (unplaced locations) + canvas (fills remainder) with subtle grid.

**Cards**: show thumbnail (first image asset) or display name. Hover shows full display name tooltip. Placed cards use `transform: translate(-50%, -50%)` from `style.left/top`.

**Dragging**: inner 66% of card area drags. On drop over canvas: updates `map_x`/`map_y` (normalised 0-1) and calls `PATCH .../meta`. On drop outside canvas: unplaces (sends empty string meta to delete keys).

**Connection mode**: outer 34% border zone initiates connection drawing. Rubber-band dashed line from source edge point. Snaps to nearest edge of other placed cards within 40px threshold. On release over target: saves `ConnectionHalf` to both location files via `PATCH .../meta` with `connections` array.

**Connection rendering**: SVG layer above canvas. Lines redrawn on card move. Right-click on line (12px hit target): confirm dialog, removes both halves from both files.

**Persistence**: `map_x`/`map_y` as floats in frontmatter. `connections` array in frontmatter. Connection IDs are `slugA__slugB` alpha sorted.

---

## 8. Known Gaps and Deferred Work

*(Items from v0.1.49 state doc still apply, plus additions below)*

- **Resemble Enhance pipeline** (`http://purpose-voxpop:8002`): service installed but returns 500 on inference (likely audio format issue server-side). Backend endpoint removed pending fix. `audio-utils.ts` WAV transcode infrastructure is in place. When ready: add `POST /projects/{p}/entities/{s}/enhance-line` endpoint (relay to `/enhance` with multipart `file` field) and re-add `🎙` enhance flow in `pane-conversation.ts` as post-processing step on the record flow.
- **Token stub Tab/Enter UX**: no visual indicator that a pending token is waiting for confirmation. Could add a subtle status hint in the editor.
- **Conversation prereq/triggers**: single event slug only. AND/OR logic deferred.
- **Multiple connections between same location pair**: schema supports it (different IDs needed), UI does not yet offer a way to create them.
- **Backlinks, slug rename cascade in body text, git commits per save**: unchanged from v0.1.49.
- **voxpop 8001 voice list is global**: not scoped to project. If multiple projects use the same character slug they will share a voice reference. Not a problem in practice yet.

---

## 9. Known Gotchas (additions since v0.1.49)

- **Conversation body is JSON, not prose**: the body field of conversation `.md` files contains raw JSON. The file watcher will update `display_name` and rebuild refs on save, but the body content is not human-readable markdown. Do not edit manually unless you know the schema.
- **`_pendingToken` is module-level in `editor.ts`**: only one pending token at a time across all open editor tabs. Last opened editor owns `_onTokenComplete`. This is pre-existing behaviour, not new.
- **Voice reference upload requires WAV**: voxpop 8001 rejects webm/opus. `blobToWav` transcode is applied before upload in the character preview recorder. Any future audio upload to voxpop must go through `blobToWav` first.
- **`ConversationEditor.el` is a wrapper div, not `editorArea`**: `_mountConversationEditor` creates a fresh `div` wrapper and passes it to the constructor. `getEl()` returns this wrapper. `editorArea.innerHTML = ''` safely detaches it; `appendChild` re-attaches it on tab switch.
- **Connection IDs after rename**: `rename_entity` cascades slug changes into `connections[].to` and `connections[].id` in all location files. If rename fails partway (e.g. exception in cascade), connection IDs may be inconsistent. Safe to repair manually: re-derive IDs as `sorted([from_slug, to_slug]).join('__')`.
- **World map card positioning**: cards use `transform: translate(-50%, -50%)` in CSS, so `style.left/style.top` refer to the card centre. `_edgePointPx` and drag calculations account for this offset (`x0 = cl - cw/2`).
