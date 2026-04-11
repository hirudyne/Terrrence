-- Terrrence Yjs collaboration state.
-- Separate DB file from the main index. Pure operational state: every row
-- here exists only because at least one client is currently editing the
-- referenced entity. When the last client disconnects, the server flushes
-- the resolved doc to Markdown on disk and deletes the row.
--
-- entity_id is a soft reference to entities.id in terrrence.db. No FK
-- because the two DBs are separate files; orphaned rows are cleaned up
-- on server start by cross-checking against the main DB.

PRAGMA journal_mode = WAL;

CREATE TABLE yjs_state (
    entity_id  INTEGER PRIMARY KEY,
    state      BLOB    NOT NULL,
    updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE schema_version (
    version    INTEGER PRIMARY KEY,
    applied_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO schema_version (version) VALUES (1);
