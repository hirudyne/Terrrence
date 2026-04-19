-- Terrrence - PostgreSQL schema
-- Generated 2026-04-19 from SQLite schema v1
-- Changes from SQLite version:
--   - SERIAL/BIGSERIAL for autoincrement PKs
--   - TIMESTAMPTZ for all timestamps
--   - BYTEA for Yjs blob
--   - assets.source added: 'generated' | 'uploaded'
--   - asset_entities PK fixed: role NULL not permitted in composite PK;
--     replaced with a UNIQUE constraint on (asset_id, entity_id, role)
--     and a surrogate SERIAL PK
--   - schema_version uses SERIAL PK
--   - All PRAGMA directives removed (Postgres handles these at server level)

-- ---------------------------------------------------------------------------
-- Identity and access
-- ---------------------------------------------------------------------------

CREATE TABLE api_keys (
    id           SERIAL      PRIMARY KEY,
    key_hash     TEXT        NOT NULL UNIQUE,
    label        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ
);

CREATE TABLE sessions (
    session_id   TEXT        PRIMARY KEY,
    api_key_id   INTEGER     NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_sessions_api_key ON sessions(api_key_id);

-- ---------------------------------------------------------------------------
-- Projects
-- ---------------------------------------------------------------------------

CREATE TABLE projects (
    id           SERIAL      PRIMARY KEY,
    slug         TEXT        NOT NULL UNIQUE,
    display_name TEXT        NOT NULL,
    owner_key_id INTEGER     NOT NULL REFERENCES api_keys(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE project_shares (
    project_id INTEGER     NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    api_key_id INTEGER     NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (project_id, api_key_id)
);

-- ---------------------------------------------------------------------------
-- Entities
-- ---------------------------------------------------------------------------

CREATE TABLE entities (
    id           SERIAL      PRIMARY KEY,
    project_id   INTEGER     NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    slug         TEXT        NOT NULL,
    type         TEXT        NOT NULL,
    display_name TEXT        NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    parent_id    INTEGER     REFERENCES entities(id) ON DELETE SET NULL,
    UNIQUE (project_id, slug)
);
CREATE INDEX idx_entities_project_type ON entities(project_id, type);
CREATE INDEX idx_entities_display      ON entities(project_id, display_name);

CREATE TABLE entity_refs (
    src_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    dst_entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    occurrences   INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (src_entity_id, dst_entity_id)
);
CREATE INDEX idx_refs_dst ON entity_refs(dst_entity_id);

-- ---------------------------------------------------------------------------
-- Tags
-- ---------------------------------------------------------------------------

CREATE TABLE tags (
    id         SERIAL  PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name       TEXT    NOT NULL,
    UNIQUE (project_id, name)
);

CREATE TABLE entity_tags (
    entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    tag_id    INTEGER NOT NULL REFERENCES tags(id)    ON DELETE CASCADE,
    PRIMARY KEY (entity_id, tag_id)
);
CREATE INDEX idx_entity_tags_tag ON entity_tags(tag_id);

-- ---------------------------------------------------------------------------
-- Assets
-- ---------------------------------------------------------------------------

CREATE TABLE assets (
    id         SERIAL      PRIMARY KEY,
    project_id INTEGER     NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    rel_path   TEXT        NOT NULL,
    mime       TEXT,
    bytes      INTEGER,
    sha256     TEXT,
    source     TEXT        NOT NULL DEFAULT 'uploaded' CHECK (source IN ('uploaded', 'generated')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (project_id, rel_path)
);

-- role is the semantic purpose of the asset in relation to the entity:
--   portrait, facing_back, facing_left, facing_right,
--   walk_front, walk_back, walk_left, walk_right,
--   scene_image, recorded, enhanced, sprite, voice
-- A given (asset_id, entity_id) pair may have at most one role (or none).
CREATE TABLE asset_entities (
    id        SERIAL  PRIMARY KEY,
    asset_id  INTEGER NOT NULL REFERENCES assets(id)   ON DELETE CASCADE,
    entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    role      TEXT,
    UNIQUE (asset_id, entity_id)
);
CREATE INDEX idx_asset_entities_entity ON asset_entities(entity_id);
CREATE INDEX idx_asset_entities_role   ON asset_entities(entity_id, role);

-- ---------------------------------------------------------------------------
-- Yjs collaboration state (previously a separate DB file)
-- ---------------------------------------------------------------------------

CREATE TABLE yjs_state (
    entity_id  INTEGER     PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
    state      BYTEA       NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Schema version
-- ---------------------------------------------------------------------------

CREATE TABLE schema_version (
    version    SERIAL      PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO schema_version (applied_at) VALUES (NOW());
