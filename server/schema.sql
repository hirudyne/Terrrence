-- Terrrence index database
-- This is a REBUILDABLE INDEX. Source of truth is the per-project Markdown files
-- on disk under /workspace/projects/<project_slug>/content/. Wiping this DB and
-- re-scanning the projects tree must reproduce all rows below except for:
--   api_keys, project_shares, sessions
-- which are operational state and have no on-disk equivalent.

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- ---------------------------------------------------------------------------
-- Identity and access
-- ---------------------------------------------------------------------------

-- API keys are the only identity primitive. The plaintext key is shown to the
-- user once at creation; only the argon2 hash is stored.
CREATE TABLE api_keys (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    key_hash     TEXT    NOT NULL UNIQUE,
    label        TEXT,                       -- human-friendly name, optional
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT
);

-- Browser sessions. Issued on successful login, referenced by an opaque
-- session_id in an HTTP-only cookie. No Max-Age/Expires set on the cookie
-- itself; rows here are pruned by the server on a TTL.
CREATE TABLE sessions (
    session_id  TEXT    PRIMARY KEY,         -- random 256-bit hex
    api_key_id  INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT   NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sessions_api_key ON sessions(api_key_id);

-- ---------------------------------------------------------------------------
-- Projects
-- ---------------------------------------------------------------------------

CREATE TABLE projects (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    slug         TEXT    NOT NULL UNIQUE,    -- on-disk directory name
    display_name TEXT    NOT NULL,
    owner_key_id INTEGER NOT NULL REFERENCES api_keys(id),
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Sharing: any row here grants the referenced api_key full rights on the project.
-- Owner has implicit full rights and need not appear here.
CREATE TABLE project_shares (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    api_key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
    granted_at TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (project_id, api_key_id)
);

-- ---------------------------------------------------------------------------
-- Entities (the index)
-- ---------------------------------------------------------------------------

-- Every game-world thing is an entity. Type lives here AND in the file
-- frontmatter; the file wins on conflict during reindex.
--
-- slug is the durable handle (derek, castle_door). It is also the filename
-- on disk: /workspace/projects/<project>/content/<slug>.md
-- display_name is what the UI shows everywhere; can be edited freely without
-- touching the slug.
CREATE TABLE entities (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    slug         TEXT    NOT NULL,
    type         TEXT    NOT NULL,
    display_name TEXT    NOT NULL,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    parent_id    INTEGER REFERENCES entities(id) ON DELETE SET NULL,
    UNIQUE (project_id, slug)
);
CREATE INDEX idx_entities_project_type ON entities(project_id, type);
CREATE INDEX idx_entities_display ON entities(project_id, display_name);

-- Entity-to-entity references discovered by parsing prose tokens
-- (@location, #character, ~item, !!event!!). Rebuilt on each file save.
-- Used for backlinks and rename-cascade.
CREATE TABLE entity_refs (
    src_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    dst_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    occurrences   INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (src_entity_id, dst_entity_id)
);
CREATE INDEX idx_refs_dst ON entity_refs(dst_entity_id);

-- ---------------------------------------------------------------------------
-- Tags (flat, multi-valued, rename-stable via entity_id)
-- ---------------------------------------------------------------------------

CREATE TABLE tags (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name       TEXT    NOT NULL,
    UNIQUE (project_id, name)
);

CREATE TABLE entity_tags (
    entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    tag_id    INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (entity_id, tag_id)
);
CREATE INDEX idx_entity_tags_tag ON entity_tags(tag_id);

-- ---------------------------------------------------------------------------
-- Assets
-- ---------------------------------------------------------------------------

-- Files under /workspace/projects/<project>/assets/. The path is relative to
-- that directory. Multi-attach: an asset can be associated with many entities
-- via asset_entities, with no folder-hierarchy implications.
CREATE TABLE assets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    rel_path    TEXT    NOT NULL,
    mime        TEXT,
    bytes       INTEGER,
    sha256      TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE (project_id, rel_path)
);

CREATE TABLE asset_entities (
    asset_id  INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    role      TEXT,                          -- e.g. sprite, voice, free-form
    PRIMARY KEY (asset_id, entity_id, role)
);
CREATE INDEX idx_asset_entities_entity ON asset_entities(entity_id);

-- ---------------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------------

CREATE TABLE schema_version (
    version    INTEGER PRIMARY KEY,
    applied_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO schema_version (version) VALUES (1);
