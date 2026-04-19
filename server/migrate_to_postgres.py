#!/usr/bin/env python3
"""
Export Terrrence SQLite data to a Postgres-compatible SQL INSERT script.
Run AFTER schema_postgres.sql has been applied to the target DB.

Usage:
  python3 migrate_to_postgres.py > migration_data.sql
  psql $DATABASE_URL -f schema_postgres.sql
  psql $DATABASE_URL -f migration_data.sql
"""

import sqlite3
import sys
from datetime import datetime

SQLITE_PATH = '/workspace/data/terrrence.db'

def q(val):
    """Escape a value for SQL."""
    if val is None:
        return 'NULL'
    if isinstance(val, (int, float)):
        return str(val)
    # Text: escape single quotes
    return "'" + str(val).replace("'", "''") + "'"

def ts(val):
    """Normalise a SQLite datetime string to timestamptz-compatible."""
    if val is None:
        return 'NULL'
    # SQLite stores as 'YYYY-MM-DD HH:MM:SS' - Postgres accepts this fine
    return q(val)

db = sqlite3.connect(SQLITE_PATH)
db.row_factory = sqlite3.Row

out = sys.stdout
out.write("-- Terrrence SQLite -> PostgreSQL data migration\n")
out.write(f"-- Generated: {datetime.utcnow().isoformat()}Z\n\n")
out.write("BEGIN;\n\n")

# Disable triggers/constraints during load
out.write("SET session_replication_role = replica;\n\n")

# ---------------------------------------------------------------------------
# api_keys
# ---------------------------------------------------------------------------
rows = db.execute("SELECT id, key_hash, label, created_at, last_seen_at FROM api_keys ORDER BY id").fetchall()
out.write("-- api_keys\n")
for r in rows:
    out.write(f"INSERT INTO api_keys (id, key_hash, label, created_at, last_seen_at) VALUES ({r['id']}, {q(r['key_hash'])}, {q(r['label'])}, {ts(r['created_at'])}, {ts(r['last_seen_at'])});\n")
if rows:
    max_id = max(r['id'] for r in rows)
    out.write(f"SELECT setval('api_keys_id_seq', {max_id});\n")
out.write("\n")

# ---------------------------------------------------------------------------
# sessions
# ---------------------------------------------------------------------------
rows = db.execute("SELECT session_id, api_key_id, created_at, last_seen_at FROM sessions ORDER BY created_at").fetchall()
out.write("-- sessions\n")
for r in rows:
    out.write(f"INSERT INTO sessions (session_id, api_key_id, created_at, last_seen_at) VALUES ({q(r['session_id'])}, {r['api_key_id']}, {ts(r['created_at'])}, {ts(r['last_seen_at'])});\n")
out.write("\n")

# ---------------------------------------------------------------------------
# projects
# ---------------------------------------------------------------------------
rows = db.execute("SELECT id, slug, display_name, owner_key_id, created_at FROM projects ORDER BY id").fetchall()
out.write("-- projects\n")
for r in rows:
    out.write(f"INSERT INTO projects (id, slug, display_name, owner_key_id, created_at) VALUES ({r['id']}, {q(r['slug'])}, {q(r['display_name'])}, {r['owner_key_id']}, {ts(r['created_at'])});\n")
if rows:
    max_id = max(r['id'] for r in rows)
    out.write(f"SELECT setval('projects_id_seq', {max_id});\n")
out.write("\n")

# ---------------------------------------------------------------------------
# project_shares
# ---------------------------------------------------------------------------
rows = db.execute("SELECT project_id, api_key_id, granted_at FROM project_shares").fetchall()
out.write("-- project_shares\n")
for r in rows:
    out.write(f"INSERT INTO project_shares (project_id, api_key_id, granted_at) VALUES ({r['project_id']}, {r['api_key_id']}, {ts(r['granted_at'])});\n")
out.write("\n")

# ---------------------------------------------------------------------------
# entities
# ---------------------------------------------------------------------------
rows = db.execute("SELECT id, project_id, slug, type, display_name, created_at, updated_at, parent_id FROM entities ORDER BY id").fetchall()
out.write("-- entities\n")
for r in rows:
    out.write(f"INSERT INTO entities (id, project_id, slug, type, display_name, created_at, updated_at, parent_id) VALUES ({r['id']}, {r['project_id']}, {q(r['slug'])}, {q(r['type'])}, {q(r['display_name'])}, {ts(r['created_at'])}, {ts(r['updated_at'])}, {q(r['parent_id'])});\n")
if rows:
    max_id = max(r['id'] for r in rows)
    out.write(f"SELECT setval('entities_id_seq', {max_id});\n")
out.write("\n")

# ---------------------------------------------------------------------------
# entity_refs
# ---------------------------------------------------------------------------
rows = db.execute("SELECT src_entity_id, dst_entity_id, occurrences FROM entity_refs").fetchall()
out.write("-- entity_refs\n")
for r in rows:
    out.write(f"INSERT INTO entity_refs (src_entity_id, dst_entity_id, occurrences) VALUES ({r['src_entity_id']}, {r['dst_entity_id']}, {r['occurrences']});\n")
out.write("\n")

# ---------------------------------------------------------------------------
# tags
# ---------------------------------------------------------------------------
rows = db.execute("SELECT id, project_id, name FROM tags ORDER BY id").fetchall()
out.write("-- tags\n")
for r in rows:
    out.write(f"INSERT INTO tags (id, project_id, name) VALUES ({r['id']}, {r['project_id']}, {q(r['name'])});\n")
if rows:
    max_id = max(r['id'] for r in rows)
    out.write(f"SELECT setval('tags_id_seq', {max_id});\n")
out.write("\n")

# ---------------------------------------------------------------------------
# entity_tags
# ---------------------------------------------------------------------------
rows = db.execute("SELECT entity_id, tag_id FROM entity_tags").fetchall()
out.write("-- entity_tags\n")
for r in rows:
    out.write(f"INSERT INTO entity_tags (entity_id, tag_id) VALUES ({r['entity_id']}, {r['tag_id']});\n")
out.write("\n")

# ---------------------------------------------------------------------------
# assets
# source: infer from rel_path ('_generated_' in filename -> 'generated')
# ---------------------------------------------------------------------------
rows = db.execute("SELECT id, project_id, rel_path, mime, bytes, sha256, created_at FROM assets ORDER BY id").fetchall()
out.write("-- assets\n")
for r in rows:
    source = 'generated' if '_generated_' in (r['rel_path'] or '') else 'uploaded'
    out.write(f"INSERT INTO assets (id, project_id, rel_path, mime, bytes, sha256, source, created_at) VALUES ({r['id']}, {r['project_id']}, {q(r['rel_path'])}, {q(r['mime'])}, {q(r['bytes'])}, {q(r['sha256'])}, '{source}', {ts(r['created_at'])});\n")
if rows:
    max_id = max(r['id'] for r in rows)
    out.write(f"SELECT setval('assets_id_seq', {max_id});\n")
out.write("\n")

# ---------------------------------------------------------------------------
# asset_entities
# Old schema: PRIMARY KEY (asset_id, entity_id, role) - role could be NULL
# New schema: UNIQUE (asset_id, entity_id), surrogate SERIAL PK
# Where multiple rows exist for same (asset_id, entity_id) with different roles,
# keep only the most specific (non-NULL) role.
# ---------------------------------------------------------------------------
rows = db.execute("SELECT asset_id, entity_id, role FROM asset_entities ORDER BY asset_id, entity_id").fetchall()
# Deduplicate: prefer non-NULL role
seen = {}
for r in rows:
    key = (r['asset_id'], r['entity_id'])
    existing_role = seen.get(key)
    if existing_role is None or (existing_role is not None and r['role'] is not None):
        seen[key] = r['role']

out.write("-- asset_entities\n")
for (asset_id, entity_id), role in sorted(seen.items()):
    out.write(f"INSERT INTO asset_entities (asset_id, entity_id, role) VALUES ({asset_id}, {entity_id}, {q(role)});\n")
out.write(f"SELECT setval('asset_entities_id_seq', {len(seen)});\n")
out.write("\n")

# ---------------------------------------------------------------------------
# Re-enable constraints
# ---------------------------------------------------------------------------
out.write("SET session_replication_role = DEFAULT;\n\n")
out.write("COMMIT;\n")

sys.stderr.write(f"Done. api_keys={len(db.execute('SELECT id FROM api_keys').fetchall())} projects={len(db.execute('SELECT id FROM projects').fetchall())} entities={len(db.execute('SELECT id FROM entities').fetchall())} assets={len(db.execute('SELECT id FROM assets').fetchall())}\n")
