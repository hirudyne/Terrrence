from __future__ import annotations

import logging
import os

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("terrrence")
import secrets
import psycopg2
import psycopg2.extras
from contextlib import contextmanager
from pathlib import Path

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from fastapi import Cookie, FastAPI, HTTPException, Request, Response
from pydantic import BaseModel

COOKIE_NAME = "terrrence_session"

def _load_secret(key: str) -> str | None:
    """Read a secret from /workspace/.secrets file, falling back to env var."""
    secrets_path = Path("/workspace/.secrets")
    if secrets_path.exists():
        for line in secrets_path.read_text().splitlines():
            line = line.strip()
            if line.startswith(key + "="):
                val = line[len(key) + 1:].strip()
                if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
                    val = val[1:-1]
                return val
    return os.environ.get(key)
INSECURE    = os.environ.get("TERRRENCE_INSECURE_COOKIES", "0") == "1"

ph  = PasswordHasher()
app = FastAPI(title="Terrrence", version="0.0.1")


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

def _pg_connect():
    return psycopg2.connect(
        host=_load_secret("PG_HOST") or "dbase",
        port=int(_load_secret("PG_PORT") or 5432),
        dbname=_load_secret("PG_DBNAME") or "terrrence_db",
        user=_load_secret("PG_USER"),
        password=_load_secret("PG_PASSWORD"),
        cursor_factory=psycopg2.extras.RealDictCursor,
    )

class _Conn:
    def __init__(self, pg_conn):
        self._conn = pg_conn

    def execute(self, sql: str, params=None):
        cur = self._conn.cursor()
        cur.execute(sql, params)
        return cur

    def commit(self):
        self._conn.commit()

    def rollback(self):
        self._conn.rollback()

    def close(self):
        self._conn.close()


@contextmanager
def db():
    conn = _Conn(_pg_connect())
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()




# ---------------------------------------------------------------------------
# Session helpers
# ---------------------------------------------------------------------------

def _new_session_id() -> str:
    return secrets.token_hex(32)


def _resolve_session(session_id: str | None):
    if not session_id:
        return None
    with db() as conn:
        row = conn.execute(
            """
            SELECT s.api_key_id, k.label
            FROM sessions s
            JOIN api_keys k ON k.id = s.api_key_id
            WHERE s.session_id = %s
            """,
            (session_id,),
        ).fetchone()
        if not row:
            return None
        conn.execute(
            "UPDATE sessions SET last_seen_at = NOW() WHERE session_id = %s",
            (session_id,),
        )
        conn.execute(
            "UPDATE api_keys SET last_seen_at = NOW() WHERE id = %s",
            (row["api_key_id"],),
        )
        return row["api_key_id"], row["label"]


def _require_session(session_id: str | None):
    resolved = _resolve_session(session_id)
    if not resolved:
        raise HTTPException(status_code=401, detail="not logged in")
    return resolved


def _set_session_cookie(response: Response, session_id: str):
    response.set_cookie(
        key=COOKIE_NAME,
        value=session_id,
        httponly=True,
        secure=not INSECURE,
        samesite="strict",
        path="/",
    )


# ---------------------------------------------------------------------------
# Routes - health / auth
# ---------------------------------------------------------------------------

_VERSION = (Path(__file__).parent.parent / "VERSION").read_text().strip()


@app.get("/health")
def health():
    return {"ok": True, "service": "terrrence", "version": _VERSION}


@app.get("/version")
def version():
    return {"version": _VERSION}


class LoginBody(BaseModel):
    api_key: str


@app.post("/login")
def login(body: LoginBody, response: Response):
    submitted = body.api_key.strip()
    if not submitted:
        raise HTTPException(status_code=400, detail="empty key")

    with db() as conn:
        rows = conn.execute("SELECT id, key_hash FROM api_keys").fetchall()

    matched_id = None
    for row in rows:
        try:
            ph.verify(row["key_hash"], submitted)
            matched_id = row["id"]
            break
        except VerifyMismatchError:
            continue

    if matched_id is None:
        raise HTTPException(status_code=401, detail="invalid key")

    session_id = _new_session_id()
    with db() as conn:
        conn.execute(
            "INSERT INTO sessions (session_id, api_key_id) VALUES (%s, %s)",
            (session_id, matched_id),
        )

    _set_session_cookie(response, session_id)
    return {"ok": True}


@app.post("/logout")
def logout(response: Response, session: str | None = Cookie(default=None, alias=COOKIE_NAME)):
    if session:
        with db() as conn:
            conn.execute("DELETE FROM sessions WHERE session_id = %s", (session,))
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"ok": True}


@app.get("/whoami")
def whoami(session: str | None = Cookie(default=None, alias=COOKIE_NAME)):
    _, label = _require_session(session)
    return {"label": label}


# ---------------------------------------------------------------------------
# Routes - projects
# ---------------------------------------------------------------------------

import re
import subprocess
from typing import Optional

SLUG_RE = re.compile(r'^[a-zA-Z0-9_-]+$')
PROJECTS_ROOT = Path(os.environ.get("TERRRENCE_PROJECTS", "/workspace/projects"))


def _derive_slug(display_name: str, entity_type: str = "") -> str:
    """Derive a filesystem-safe slug from a display name.
    Chapters: 'Chapter 3 - Some Title' -> 'C3'
    Others:   'Sholver\'s Mum' -> 'sholver_s_mum'
    """
    import unicodedata
    if entity_type == "chapter":
        m = re.match(r'^[Cc]hapter\s+(\d+)', display_name.strip())
        if m:
            return f"C{m.group(1)}"
    nfkd = unicodedata.normalize("NFKD", display_name)
    ascii_str = nfkd.encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r'[^a-z0-9]+', '_', ascii_str.lower()).strip('_')
    return slug[:64] or "entity"


def _slug_valid(slug: str) -> bool:
    return bool(SLUG_RE.match(slug)) and len(slug) <= 64


def _bootstrap_project_dir(slug: str):
    project_dir = PROJECTS_ROOT / slug
    (project_dir / "content").mkdir(parents=True, exist_ok=True)
    (project_dir / "assets").mkdir(parents=True, exist_ok=True)
    if not (project_dir / ".git").exists():
        subprocess.run(["git", "init", str(project_dir)], check=True, capture_output=True)


def _ensure_game_entity(project_slug: str, project_id: int, display_name: str) -> None:
    """Create the game entity for a project if it does not exist."""
    with db() as conn:
        existing = conn.execute(
            "SELECT id FROM entities WHERE project_id = %s AND type = 'game'",
            (project_id,),
        ).fetchone()
        if existing:
            return
        conn.execute(
            "INSERT INTO entities (project_id, slug, type, display_name) VALUES (%s, %s, 'game', %s)",
            (project_id, "game", display_name),
        )
    _write_entity_file(project_slug, "game", display_name, "game", "")


class CreateProjectBody(BaseModel):
    slug: str
    display_name: str


@app.post("/projects", status_code=201)
def create_project(body: CreateProjectBody, session: str | None = Cookie(default=None, alias=COOKIE_NAME)):
    api_key_id, _ = _require_session(session)
    if not _slug_valid(body.slug):
        raise HTTPException(status_code=400, detail="invalid slug")
    with db() as conn:
        existing = conn.execute("SELECT id FROM projects WHERE slug = %s", (body.slug,)).fetchone()
        if existing:
            raise HTTPException(status_code=409, detail="slug taken")
        conn.execute(
            "INSERT INTO projects (slug, display_name, owner_key_id) VALUES (%s, %s, %s)",
            (body.slug, body.display_name.strip(), api_key_id),
        )
    with db() as conn:
        project_row = conn.execute("SELECT id FROM projects WHERE slug = %s", (body.slug,)).fetchone()
        project_id = project_row["id"]
    _bootstrap_project_dir(body.slug)
    _ensure_game_entity(body.slug, project_id, body.display_name.strip())
    return {"slug": body.slug, "display_name": body.display_name.strip()}


@app.get("/projects")
def list_projects(session: str | None = Cookie(default=None, alias=COOKIE_NAME)):
    api_key_id, _ = _require_session(session)
    with db() as conn:
        rows = conn.execute(
            """
            SELECT p.slug, p.display_name, p.owner_key_id
            FROM projects p
            WHERE p.owner_key_id = %s
            UNION
            SELECT p.slug, p.display_name, p.owner_key_id
            FROM projects p
            JOIN project_shares ps ON ps.project_id = p.id
            WHERE ps.api_key_id = %s
            """,
            (api_key_id, api_key_id),
        ).fetchall()
    return [{"slug": r["slug"], "display_name": r["display_name"], "owned": r["owner_key_id"] == api_key_id} for r in rows]


class ShareProjectBody(BaseModel):
    api_key_label: str


@app.post("/projects/{slug}/share", status_code=201)
def share_project(slug: str, body: ShareProjectBody, session: str | None = Cookie(default=None, alias=COOKIE_NAME)):
    api_key_id, _ = _require_session(session)
    with db() as conn:
        project = conn.execute(
            "SELECT id, owner_key_id FROM projects WHERE slug = %s", (slug,)
        ).fetchone()
        if not project:
            raise HTTPException(status_code=404, detail="project not found")
        if project["owner_key_id"] != api_key_id:
            raise HTTPException(status_code=403, detail="not owner")
        target = conn.execute(
            "SELECT id FROM api_keys WHERE label = %s", (body.api_key_label,)
        ).fetchone()
        if not target:
            raise HTTPException(status_code=404, detail="target key not found")
        existing = conn.execute(
            "SELECT 1 FROM project_shares WHERE project_id = %s AND api_key_id = %s",
            (project["id"], target["id"]),
        ).fetchone()
        if not existing:
            conn.execute(
                "INSERT INTO project_shares (project_id, api_key_id) VALUES (%s, %s)",
                (project["id"], target["id"]),
            )
    return {"ok": True}


# ---------------------------------------------------------------------------
# Routes - entities
# ---------------------------------------------------------------------------

import frontmatter as fm

ENTITY_TYPES = {"location", "character", "item", "event", "game", "chapter", "conversation", "spot", "part"}
REF_PATTERNS = [
    (re.compile(r'@@([^@]+)@@'),             "location"),
    (re.compile(r'##([^#]+)##'),             "character"),
    (re.compile(r'~~([^~]+)~~'),             "item"),
    (re.compile(r'!!([^!]+)!!([^!]+)!!'),    "event"),
    (re.compile(r'\?\?([^%s]+)\?\?'),           "chapter"),
    (re.compile(r'\u201c\u201c([^\u201c\u201d]+)\u201d\u201d'), "conversation"),
    (re.compile(r'%%([^%]+)%%'),             "spot"),
]


def _project_for_session(slug: str, api_key_id: int):
    with db() as conn:
        row = conn.execute(
            """
            SELECT p.id, p.owner_key_id FROM projects p
            WHERE p.slug = %s
            AND (
                p.owner_key_id = %s
                OR EXISTS (
                    SELECT 1 FROM project_shares ps
                    WHERE ps.project_id = p.id AND ps.api_key_id = %s
                )
            )
            """,
            (slug, api_key_id, api_key_id),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="project not found")
        return row


def _entity_path(project_slug: str, entity_slug: str) -> Path:
    return PROJECTS_ROOT / project_slug / "content" / f"{entity_slug}.md"


def _write_entity_file(project_slug: str, entity_slug: str, display_name: str, entity_type: str, body_text: str, extra_meta: dict | None = None):
    path = _entity_path(project_slug, entity_slug)
    post = fm.Post(body_text)
    post.metadata["slug"]         = entity_slug
    post.metadata["type"]         = entity_type
    post.metadata["display_name"] = display_name
    if extra_meta:
        post.metadata.update(extra_meta)
    path.write_text(fm.dumps(post), encoding="utf-8")


def _read_entity_file(project_slug: str, entity_slug: str) -> fm.Post:
    path = _entity_path(project_slug, entity_slug)
    if not path.exists():
        raise HTTPException(status_code=404, detail="entity file not found")
    return fm.load(str(path))


def _extract_refs(body_text: str) -> list[tuple[str, str, str]]:
    """Return list of (slug, type, display_name) tuples from prose references."""
    refs = []
    for pattern, ref_type in [REF_PATTERNS[0], REF_PATTERNS[1], REF_PATTERNS[2], REF_PATTERNS[4], REF_PATTERNS[5], REF_PATTERNS[6]]:
        for m in pattern.finditer(body_text):
            display = m.group(1).strip()
            slug = _derive_slug(display, ref_type)
            refs.append((slug, ref_type, display))
    event_pat = REF_PATTERNS[3][0]
    for m in event_pat.finditer(body_text):
        for part in (m.group(1), m.group(2)):
            for inner_pat, inner_type in [REF_PATTERNS[0], REF_PATTERNS[1], REF_PATTERNS[2], REF_PATTERNS[4], REF_PATTERNS[5], REF_PATTERNS[6]]:
                for im in inner_pat.finditer(part):
                    display = im.group(1).strip()
                    slug = _derive_slug(display, inner_type)
                    refs.append((slug, inner_type, display))
    return refs


def _rebuild_refs(project_id: int, entity_id: int, body_text: str,
                  entity_type: str = "", project_slug: str = "") -> list[str]:
    """Rebuild entity_refs for entity_id from body_text.
    If entity_type and project_slug are provided, auto-stubs unresolved refs.
    Returns list of newly created stub slugs.
    """
    refs = _extract_refs(body_text)
    new_stubs: list[str] = []

    with db() as conn:
        conn.execute("DELETE FROM entity_refs WHERE src_entity_id = %s", (entity_id,))
        counts: dict[tuple, int] = {}
        for slug, ref_type, display_name_ref in refs:
            target = conn.execute(
                "SELECT id FROM entities WHERE project_id = %s AND slug = %s",
                (project_id, slug),
            ).fetchone()
            if not target and project_slug:
                # Auto-stub: skip events/conversations (require parent context) and game
                if ref_type in ("event", "conversation", "spot", "game"):
                    continue
                # For chapters we need a game entity parent
                parent_id = None
                if ref_type == "chapter":
                    game_row = conn.execute(
                        "SELECT id FROM entities WHERE project_id = %s AND type = 'game'",
                        (project_id,),
                    ).fetchone()
                    if game_row:
                        parent_id = game_row["id"]
                    else:
                        continue
                cur = conn.execute(
                    "INSERT INTO entities (project_id, slug, type, display_name, parent_id) VALUES (%s,%s,%s,%s,%s) RETURNING id",
                    (project_id, slug, ref_type, display_name_ref, parent_id),
                )
                stub_id = cur.fetchone()["id"]
                target = conn.execute("SELECT id FROM entities WHERE id=%s", (stub_id,)).fetchone()
                new_stubs.append(slug)
                _write_entity_file(project_slug, slug, display_name_ref, ref_type, "")
            if target:
                key = (entity_id, target["id"])
                counts[key] = counts.get(key, 0) + 1
        for (src, tgt), cnt in counts.items():
            conn.execute(
                """
                INSERT INTO entity_refs (src_entity_id, dst_entity_id, occurrences)
                VALUES (%s, %s, %s)
                ON CONFLICT(src_entity_id, dst_entity_id)
                DO UPDATE SET occurrences = excluded.occurrences
                """,
                (src, tgt, cnt),
            )
    return new_stubs


class CreateEntityBody(BaseModel):
    slug: str
    display_name: str
    type: str
    body: str = ""
    parent_slug: Optional[str] = None


@app.post("/projects/{project_slug}/entities", status_code=201)
def create_entity(
    project_slug: str,
    body: CreateEntityBody,
    session: str | None = Cookie(default=None, alias=COOKIE_NAME),
):
    api_key_id, _ = _require_session(session)
    project = _project_for_session(project_slug, api_key_id)
    if not _slug_valid(body.slug):
        raise HTTPException(status_code=400, detail="invalid slug")
    if body.type not in ENTITY_TYPES:
        raise HTTPException(status_code=400, detail=f"type must be one of {sorted(ENTITY_TYPES)}")
    # only one game entity per project
    if body.type == "game":
        with db() as conn:
            existing_game = conn.execute(
                "SELECT id FROM entities WHERE project_id = %s AND type = 'game'",
                (project["id"],),
            ).fetchone()
            if existing_game:
                raise HTTPException(status_code=409, detail="project already has a game entity")
    # chapters must be parented to game; spots must be parented to a location; conversations must be parented to a character
    parent_id: int | None = None
    if body.type == "chapter":
        with db() as conn:
            game_row = conn.execute(
                "SELECT id FROM entities WHERE project_id = %s AND type = 'game'",
                (project["id"],),
            ).fetchone()
            if not game_row:
                raise HTTPException(status_code=409, detail="create the game entity first")
            parent_id = game_row["id"]
    elif body.type == "spot":
        if not body.parent_slug:
            raise HTTPException(status_code=400, detail="spots require a parent location slug")
        with db() as conn:
            parent_row = conn.execute(
                "SELECT id FROM entities WHERE project_id = %s AND slug = %s AND type = 'location'",
                (project["id"], body.parent_slug),
            ).fetchone()
            if not parent_row:
                raise HTTPException(status_code=404, detail="parent location not found")
            parent_id = parent_row["id"]
    elif body.parent_slug:
        with db() as conn:
            parent_row = conn.execute(
                "SELECT id FROM entities WHERE project_id = %s AND slug = %s",
                (project["id"], body.parent_slug),
            ).fetchone()
            if not parent_row:
                raise HTTPException(status_code=404, detail="parent entity not found")
            parent_id = parent_row["id"]
    with db() as conn:
        existing = conn.execute(
            "SELECT id FROM entities WHERE project_id = %s AND slug = %s",
            (project["id"], body.slug),
        ).fetchone()
        if existing:
            raise HTTPException(status_code=409, detail="slug taken")
        cur = conn.execute(
            "INSERT INTO entities (project_id, slug, type, display_name, parent_id) VALUES (%s, %s, %s, %s, %s) RETURNING id",
            (project["id"], body.slug, body.type, body.display_name.strip(), parent_id),
        )
        entity_id = cur.fetchone()["id"]
    _write_entity_file(project_slug, body.slug, body.display_name.strip(), body.type, body.body)
    _rebuild_refs(project["id"], entity_id, body.body,
                  entity_type=body.type, project_slug=project_slug)
    return {"slug": body.slug, "display_name": body.display_name.strip(), "type": body.type, "parent_id": parent_id}


@app.delete("/projects/{project_slug}/entities/{entity_slug}", status_code=204)
def delete_entity(
    project_slug: str,
    entity_slug: str,
    session: str | None = Cookie(default=None, alias=COOKIE_NAME),
):
    api_key_id, _ = _require_session(session)
    project = _project_for_session(project_slug, api_key_id)
    with db() as conn:
        entity = conn.execute(
            "SELECT id, type FROM entities WHERE project_id = %s AND slug = %s",
            (project["id"], entity_slug),
        ).fetchone()
        if not entity:
            raise HTTPException(status_code=404, detail="entity not found")
        if entity["type"] == "game":
            raise HTTPException(status_code=403, detail="the game entity cannot be deleted")
        conn.execute("DELETE FROM entities WHERE id = %s", (entity["id"],))
    entity_path = _entity_path(project_slug, entity_slug)
    if entity_path.exists():
        entity_path.unlink()



class RenameEntityBody(BaseModel):
    display_name: str


@app.post("/projects/{project_slug}/entities/{entity_slug}/rename", status_code=200)
def rename_entity(
    project_slug: str,
    entity_slug: str,
    body: RenameEntityBody,
    session: str | None = Cookie(default=None, alias=COOKIE_NAME),
):
    """Rename an entity: updates display_name, derives new slug, renames file,
    updates all slug references in other entity files (connections frontmatter),
    updates DB rows. Chapters and game entities: display_name updated but slug unchanged."""
    api_key_id, _ = _require_session(session)
    project = _project_for_session(project_slug, api_key_id)

    new_display_name = body.display_name.strip()
    if not new_display_name:
        raise HTTPException(status_code=422, detail="display_name required")

    with db() as conn:
        entity = conn.execute(
            "SELECT id, type, display_name FROM entities WHERE project_id = %s AND slug = %s",
            (project["id"], entity_slug),
        ).fetchone()
        if not entity:
            raise HTTPException(status_code=404, detail="entity not found")

    entity_type = entity["type"]
    old_slug = entity_slug

    # Chapters and game: only update display_name, no slug change
    slug_changes = entity_type not in ("chapter", "game")
    new_slug = _derive_slug(new_display_name, entity_type) if slug_changes else old_slug

    if new_slug != old_slug and slug_changes:
        # Check for collision
        with db() as conn:
            existing = conn.execute(
                "SELECT id FROM entities WHERE project_id = %s AND slug = %s",
                (project["id"], new_slug),
            ).fetchone()
            if existing:
                raise HTTPException(status_code=409, detail=f"slug '{new_slug}' already exists")

    # Read current file
    old_post = _read_entity_file(project_slug, old_slug)
    extra_meta = {k: v for k, v in old_post.metadata.items()
                  if k not in ("slug", "type", "display_name")}

    # Write updated file at old path first (display_name update applies regardless)
    _write_entity_file(project_slug, old_slug, new_display_name, entity_type,
                       old_post.content, extra_meta=extra_meta)

    if slug_changes and new_slug != old_slug:
        # Rename the file
        old_path = _entity_path(project_slug, old_slug)
        new_path = _entity_path(project_slug, new_slug)
        old_path.rename(new_path)

        # Re-write at new path with corrected slug in frontmatter
        new_post = _read_entity_file(project_slug, new_slug)
        new_extra = {k: v for k, v in new_post.metadata.items()
                     if k not in ("slug", "type", "display_name")}
        _write_entity_file(project_slug, new_slug, new_display_name, entity_type,
                           new_post.content, extra_meta=new_extra)

        # Update DB: entity slug and display_name
        with db() as conn:
            conn.execute(
                "UPDATE entities SET slug = %s, display_name = %s WHERE id = %s",
                (new_slug, new_display_name, entity["id"]),
            )
            # Update parent_slug references in DB (children of this entity)
            conn.execute(
                "UPDATE entities SET parent_id = (SELECT id FROM entities WHERE project_id = %s AND slug = %s) "
                "WHERE parent_id = %s",
                (project["id"], new_slug, entity["id"]),
            )

        # Cascade slug update in connections frontmatter of all other location files
        content_dir = PROJECTS_ROOT / project_slug / "content"
        for md_path in content_dir.glob("*.md"):
            if md_path.stem == new_slug:
                continue
            try:
                post = fm.load(str(md_path))
                changed = False
                conns = post.metadata.get("connections")
                if isinstance(conns, list):
                    new_conns = []
                    for half in conns:
                        if not isinstance(half, dict):
                            new_conns.append(half)
                            continue
                        h = dict(half)
                        if h.get("to") == old_slug:
                            h["to"] = new_slug
                            changed = True
                        # Rebuild id: always slugA__slugB alpha-sorted
                        this_slug = md_path.stem
                        other_slug = h.get("to", "")
                        new_id = "__".join(sorted([this_slug, other_slug]))
                        if h.get("id") != new_id:
                            h["id"] = new_id
                            changed = True
                        new_conns.append(h)
                    if changed:
                        post.metadata["connections"] = new_conns
                        with open(str(md_path), "w", encoding="utf-8") as f:
                            f.write(fm.dumps(post))
            except Exception as e:
                log.warning("rename cascade: failed to update %s: %s", md_path, e)

        # Also update connections in the renamed entity's own file
        try:
            post = fm.load(str(_entity_path(project_slug, new_slug)))
            conns = post.metadata.get("connections")
            if isinstance(conns, list):
                new_conns = []
                for half in conns:
                    if not isinstance(half, dict):
                        new_conns.append(half)
                        continue
                    h = dict(half)
                    other_slug = h.get("to", "")
                    new_id = "__".join(sorted([new_slug, other_slug]))
                    if h.get("id") != new_id:
                        h["id"] = new_id
                    new_conns.append(h)
                post.metadata["connections"] = new_conns
                post.metadata["slug"] = new_slug
                with open(str(_entity_path(project_slug, new_slug)), "w", encoding="utf-8") as f:
                    f.write(fm.dumps(post))
        except Exception as e:
            log.warning("rename cascade: failed to update own connections in %s: %s", new_slug, e)

        # Rebuild refs for the renamed entity
        _rebuild_refs(project["id"], entity["id"], old_post.content,
                      entity_type=entity_type, project_slug=project_slug)

    else:
        # No slug change: just update display_name in DB
        with db() as conn:
            conn.execute(
                "UPDATE entities SET display_name = %s WHERE id = %s",
                (new_display_name, entity["id"]),
            )

    # Cascade display_name change into body-text token references across all entity files.
    # Applies regardless of whether the slug changed.
    old_display_name = entity["display_name"]
    if new_display_name != old_display_name:
        _cascade_token_rename(project_slug, entity_type, old_display_name, new_display_name)

    return {"slug": new_slug, "display_name": new_display_name, "type": entity_type}


def _cascade_token_rename(project_slug: str, entity_type: str, old_display: str, new_display: str) -> None:
    """Replace inline token references to old_display with new_display across all entity body files."""
    delimiters: dict[str, tuple[str, str]] = {
        "location":     ("@@", "@@"),
        "character":    ("##", "##"),
        "item":         ("~~", "~~"),
        "chapter":      ("??", "??"),
        "conversation": ("\u201c\u201c", "\u201d\u201d"),
        "spot":         ("%%", "%%"),
    }
    pair = delimiters.get(entity_type)
    if not pair:
        return
    open_d, close_d = pair
    old_token = f"{open_d}{old_display}{close_d}"
    new_token = f"{open_d}{new_display}{close_d}"

    content_dir = PROJECTS_ROOT / project_slug / "content"
    for md_path in content_dir.glob("*.md"):
        try:
            post = fm.load(str(md_path))
            if old_token in post.content:
                post.content = post.content.replace(old_token, new_token)
                with open(str(md_path), "w", encoding="utf-8") as f:
                    f.write(fm.dumps(post))
        except Exception as e:
            log.warning("rename cascade body: failed to update %s: %s", md_path, e)


@app.get("/projects/{project_slug}/entities")
def list_entities(
    project_slug: str,
    session: str | None = Cookie(default=None, alias=COOKIE_NAME),
    type: Optional[str] = None,
):
    api_key_id, _ = _require_session(session)
    project = _project_for_session(project_slug, api_key_id)
    with db() as conn:
        if type:
            rows = conn.execute(
                """SELECT e.slug, e.type, e.display_name,
                          p.slug AS parent_slug, e.updated_at
                   FROM entities e
                   LEFT JOIN entities p ON p.id = e.parent_id
                   WHERE e.project_id = %s AND e.type = %s""",
                (project["id"], type),
            ).fetchall()
        else:
            rows = conn.execute(
                """SELECT e.slug, e.type, e.display_name,
                          p.slug AS parent_slug, e.updated_at
                   FROM entities e
                   LEFT JOIN entities p ON p.id = e.parent_id
                   WHERE e.project_id = %s""",
                (project["id"],),
            ).fetchall()
    return [{"slug": r["slug"], "type": r["type"], "display_name": r["display_name"], "parent_slug": r["parent_slug"], "updated_at": r["updated_at"]} for r in rows]


@app.get("/projects/{project_slug}/entities/{entity_slug}")
def get_entity(
    project_slug: str,
    entity_slug: str,
    session: str | None = Cookie(default=None, alias=COOKIE_NAME),
):
    api_key_id, _ = _require_session(session)
    _project_for_session(project_slug, api_key_id)
    post = _read_entity_file(project_slug, entity_slug)
    return {
        "slug":         post.metadata.get("slug", entity_slug),
        "type":         post.metadata.get("type"),
        "display_name": post.metadata.get("display_name"),
        "body":         post.content,
        "meta":         {k: v for k, v in post.metadata.items() if k not in ("slug", "type", "display_name")},
    }


class UpdateEntityBody(BaseModel):
    display_name: Optional[str] = None
    body: Optional[str] = None
    meta: Optional[dict] = None



class EnsureEntityBody(BaseModel):
    display_name: str
    type: str
    parent_slug: Optional[str] = None


@app.post("/projects/{project_slug}/entities/ensure", status_code=200)
def ensure_entity(
    project_slug: str,
    body: EnsureEntityBody,
    session: str | None = Cookie(default=None, alias=COOKIE_NAME),
):
    """Return existing entity or create a stub. Used by the editor for inline token creation."""
    api_key_id, _ = _require_session(session)
    project = _project_for_session(project_slug, api_key_id)
    display_name = body.display_name.strip()
    if not display_name:
        raise HTTPException(status_code=400, detail="empty display name")
    if body.type not in ENTITY_TYPES:
        raise HTTPException(status_code=400, detail="invalid type")
    slug = _derive_slug(display_name, body.type)
    if not slug or not _slug_valid(slug):
        raise HTTPException(status_code=400, detail="could not derive valid slug")
    with db() as conn:
        existing = conn.execute(
            "SELECT slug, type, display_name, parent_id FROM entities WHERE project_id = %s AND slug = %s",
            (project["id"], slug),
        ).fetchone()
        if existing:
            return {"slug": existing["slug"], "type": existing["type"],
                    "display_name": existing["display_name"], "created": False}
        parent_id = None
        if body.type == "chapter":
            game_row = conn.execute(
                "SELECT id FROM entities WHERE project_id = %s AND type = 'game'",
                (project["id"],),
            ).fetchone()
            if game_row:
                parent_id = game_row["id"]
        elif body.type == "event":
            if not body.parent_slug:
                return {"slug": None, "type": "event", "display_name": display_name, "created": False, "blocked": True}
            parent_row = conn.execute(
                "SELECT id FROM entities WHERE project_id = %s AND slug = %s AND type = 'chapter'",
                (project["id"], body.parent_slug),
            ).fetchone()
            if not parent_row:
                return {"slug": None, "type": "event", "display_name": display_name, "created": False, "blocked": True}
            parent_id = parent_row["id"]
        elif body.type == "conversation":
            if not body.parent_slug:
                return {"slug": None, "type": "conversation", "display_name": display_name, "created": False, "blocked": True}
            parent_row = conn.execute(
                "SELECT id FROM entities WHERE project_id = %s AND slug = %s AND type = 'character'",
                (project["id"], body.parent_slug),
            ).fetchone()
            if not parent_row:
                return {"slug": None, "type": "conversation", "display_name": display_name, "created": False, "blocked": True}
            parent_id = parent_row["id"]
        elif body.type == "spot":
            if not body.parent_slug:
                return {"slug": None, "type": "spot", "display_name": display_name, "created": False, "blocked": True}
            parent_row = conn.execute(
                "SELECT id FROM entities WHERE project_id = %s AND slug = %s AND type = 'location'",
                (project["id"], body.parent_slug),
            ).fetchone()
            if not parent_row:
                return {"slug": None, "type": "spot", "display_name": display_name, "created": False, "blocked": True}
            parent_id = parent_row["id"]
        elif body.parent_slug:
            parent_row = conn.execute(
                "SELECT id FROM entities WHERE project_id = %s AND slug = %s",
                (project["id"], body.parent_slug),
            ).fetchone()
            if parent_row:
                parent_id = parent_row["id"]
        cur = conn.execute(
            "INSERT INTO entities (project_id, slug, type, display_name, parent_id) VALUES (%s, %s, %s, %s, %s) RETURNING id",
            (project["id"], slug, body.type, display_name, parent_id),
        )
        entity_id = cur.fetchone()["id"]
    _write_entity_file(project_slug, slug, display_name, body.type, "")
    return {"slug": slug, "type": body.type, "display_name": display_name, "created": True}



@app.get("/projects/{project_slug}/entities/{entity_slug}/backlinks")
def get_backlinks(
    project_slug: str,
    entity_slug: str,
    session: str | None = Cookie(default=None, alias=COOKIE_NAME),
):
    api_key_id, _ = _require_session(session)
    project = _project_for_session(project_slug, api_key_id)
    with db() as conn:
        target = conn.execute(
            "SELECT id FROM entities WHERE project_id = %s AND slug = %s",
            (project["id"], entity_slug),
        ).fetchone()
        if not target:
            raise HTTPException(status_code=404, detail="entity not found")
        rows = conn.execute(
            """
            SELECT e.slug, e.type, e.display_name, er.occurrences
            FROM entity_refs er
            JOIN entities e ON e.id = er.src_entity_id
            WHERE er.dst_entity_id = %s
            ORDER BY e.type, e.display_name
            """,
            (target["id"],),
        ).fetchall()
    return [{"slug": r["slug"], "type": r["type"], "display_name": r["display_name"], "occurrences": r["occurrences"]} for r in rows]


@app.patch("/projects/{project_slug}/entities/{entity_slug}")
def update_entity(
    project_slug: str,
    entity_slug: str,
    body: UpdateEntityBody,
    session: str | None = Cookie(default=None, alias=COOKIE_NAME),
):
    api_key_id, _ = _require_session(session)
    project = _project_for_session(project_slug, api_key_id)
    with db() as conn:
        entity = conn.execute(
            "SELECT id, type, display_name FROM entities WHERE project_id = %s AND slug = %s",
            (project["id"], entity_slug),
        ).fetchone()
        if not entity:
            raise HTTPException(status_code=404, detail="entity not found")

    post = _read_entity_file(project_slug, entity_slug)
    # Prefer file's display_name over DB as source of truth on fallback
    file_display_name = post.metadata.get("display_name") or entity["display_name"]
    new_display_name = body.display_name.strip() if body.display_name is not None else file_display_name
    new_body         = body.body if body.body is not None else post.content

    # Merge incoming meta with existing, stripping reserved keys
    reserved = {"slug", "type", "display_name"}
    existing_meta = {k: v for k, v in post.metadata.items() if k not in reserved}
    if body.meta is not None:
        new_meta = {k: v for k, v in body.meta.items() if k not in reserved}
        # Empty string value = delete the key
        for k, v in new_meta.items():
            if v == "" or v is None:
                existing_meta.pop(k, None)
            else:
                existing_meta[k] = v
    else:
        new_meta = existing_meta

    _write_entity_file(project_slug, entity_slug, new_display_name, entity["type"], new_body, extra_meta=existing_meta)

    with db() as conn:
        conn.execute(
            "UPDATE entities SET display_name = %s WHERE id = %s",
            (new_display_name, entity["id"]),
        )
    _rebuild_refs(project["id"], entity["id"], new_body,
                  entity_type=entity["type"], project_slug=project_slug)
    log.debug("Saved %s/%s (%d bytes)", project_slug, entity_slug, len(new_body))
    return {"slug": entity_slug, "display_name": new_display_name, "type": entity["type"]}


# ---------------------------------------------------------------------------
# Yjs WebSocket endpoint
# ---------------------------------------------------------------------------

import asyncio
from fastapi import WebSocket, WebSocketDisconnect
import y_py as Y_proto

# ---------------------------------------------------------------------------
# Yjs sync protocol helpers (inlined from ypy_websocket.yutils)
# ---------------------------------------------------------------------------

MSG_SYNC      = 0
MSG_AWARENESS = 1
SYNC_STEP1    = 0
SYNC_STEP2    = 1
SYNC_UPDATE   = 2


def _write_var_uint(n: int) -> bytes:
    res = []
    while n > 127:
        res.append(128 | (127 & n))
        n >>= 7
    res.append(n)
    return bytes(res)


def _read_var_uint(data: bytes, i: int) -> tuple[int, int]:
    """Return (value, new_index)."""
    val = 0
    shift = 0
    while True:
        b = data[i]; i += 1
        val |= (b & 0x7F) << shift
        shift += 7
        if b < 128:
            break
    return val, i


def _read_message(data: bytes, i: int) -> tuple[bytes, int]:
    """Read a length-prefixed message. Return (payload, new_index)."""
    length, i = _read_var_uint(data, i)
    return data[i:i + length], i + length


def _make_msg(msg_type: int, sync_type: int, payload: bytes) -> bytes:
    return bytes([msg_type, sync_type]) + _write_var_uint(len(payload)) + payload


def _sync_step1(ydoc: Y_proto.YDoc) -> bytes:
    sv = Y_proto.encode_state_vector(ydoc)
    return _make_msg(MSG_SYNC, SYNC_STEP1, sv)


def _sync_step2(ydoc: Y_proto.YDoc, remote_sv: bytes) -> bytes:
    update = Y_proto.encode_state_as_update(ydoc, remote_sv)
    return _make_msg(MSG_SYNC, SYNC_STEP2, update)


def _update_msg(update: bytes) -> bytes:
    return _make_msg(MSG_SYNC, SYNC_UPDATE, update)


# ---------------------------------------------------------------------------
# Room: one YDoc per project/entity, shared across all connected clients
# ---------------------------------------------------------------------------

class _YjsRoom:
    def __init__(self, name: str):
        self.name = name
        self.ydoc = Y_proto.YDoc()
        # websocket objects currently connected
        self.clients: list[WebSocket] = []
        # broadcast queue: updates from one client go to all others
        self._update_queue: asyncio.Queue = asyncio.Queue()
        self._broadcast_task: asyncio.Task | None = None
        self._sub: object | None = None  # ydoc observer subscription

    def start(self) -> None:
        """Start the broadcast task and subscribe to doc updates."""
        def _on_update(event: Y_proto.AfterTransactionEvent) -> None:
            update = event.get_update()
            if update and update != b"\x00\x00":
                self._update_queue.put_nowait(update)

        self._sub = self.ydoc.observe_after_transaction(_on_update)
        self._broadcast_task = asyncio.create_task(self._broadcaster())

    async def _broadcaster(self) -> None:
        """Forward doc updates to all connected clients."""
        while True:
            try:
                update = await self._update_queue.get()
                msg = _update_msg(update)
                dead = []
                for ws in list(self.clients):
                    try:
                        await ws.send_bytes(msg)
                    except Exception:
                        dead.append(ws)
                for ws in dead:
                    self.clients = [c for c in self.clients if c is not ws]
            except asyncio.CancelledError:
                break
            except Exception as exc:
                log.debug("YjsRoom broadcaster error in %s: %s", self.name, exc)

    def stop(self) -> None:
        if self._broadcast_task:
            self._broadcast_task.cancel()
            self._broadcast_task = None


# room registry: "project_slug/entity_slug" -> _YjsRoom
_yjs_rooms: dict[str, _YjsRoom] = {}


def _get_or_create_room(name: str) -> _YjsRoom:
    if name not in _yjs_rooms:
        room = _YjsRoom(name)
        room.start()
        _yjs_rooms[name] = room
        log.debug("YjsRoom created: %s", name)
    return _yjs_rooms[name]


def _maybe_cleanup_room(name: str) -> None:
    room = _yjs_rooms.get(name)
    if room and not room.clients:
        room.stop()
        del _yjs_rooms[name]
        log.debug("YjsRoom cleaned up: %s", name)


@app.websocket("/ws/yjs/{project_slug}/{entity_slug}")
async def yjs_ws(
    websocket: WebSocket,
    project_slug: str,
    entity_slug: str,
):
    # Auth
    cookie_header = websocket.headers.get("cookie", "")
    session_id = None
    for part in cookie_header.split(";"):
        part = part.strip()
        if part.startswith(COOKIE_NAME + "="):
            session_id = part[len(COOKIE_NAME) + 1:]
            break
    if not session_id or _resolve_session(session_id) is None:
        await websocket.close(code=4401)
        return

    room_name = f"{project_slug}/{entity_slug}"
    log.info("Yjs WS connect: %s", room_name)

    await websocket.accept()
    room = _get_or_create_room(room_name)
    room.clients.append(websocket)

    try:
        # Send sync step 1 to initiate sync
        await websocket.send_bytes(_sync_step1(room.ydoc))

        async for raw in websocket.iter_bytes():
            if not raw:
                continue
            msg_type = raw[0]

            if msg_type == MSG_SYNC:
                sync_type = raw[1]
                payload, _ = _read_message(raw, 2)

                if sync_type == SYNC_STEP1:
                    # Client is telling us its state vector - send them what they are missing
                    await websocket.send_bytes(_sync_step2(room.ydoc, payload))

                elif sync_type in (SYNC_STEP2, SYNC_UPDATE):
                    # Client is sending an update - apply to our doc
                    if payload and payload != b"\x00\x00":
                        Y_proto.apply_update(room.ydoc, payload)

            elif msg_type == MSG_AWARENESS:
                # Forward awareness messages to all other clients as-is
                for other in list(room.clients):
                    if other is not websocket:
                        try:
                            await other.send_bytes(raw)
                        except Exception:
                            pass

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        log.debug("Yjs WS error %s: %s", room_name, exc)
    finally:
        room.clients = [c for c in room.clients if c is not websocket]
        _maybe_cleanup_room(room_name)
        log.info("Yjs WS disconnect: %s", room_name)



# ---------------------------------------------------------------------------
# Tags
# ---------------------------------------------------------------------------


@app.get("/projects/{project_slug}/tags")
def list_tags(
    project_slug: str,
    session: str | None = Cookie(default=None, alias=COOKIE_NAME),
):
    api_key_id, _ = _require_session(session)
    project = _project_for_session(project_slug, api_key_id)
    with db() as conn:
        rows = conn.execute(
            "SELECT id, name FROM tags WHERE project_id = %s ORDER BY name",
            (project["id"],),
        ).fetchall()
    return [{"id": r["id"], "name": r["name"]} for r in rows]


@app.get("/projects/{project_slug}/entities/{entity_slug}/tags")
def list_entity_tags(
    project_slug: str,
    entity_slug: str,
    session: str | None = Cookie(default=None, alias=COOKIE_NAME),
):
    api_key_id, _ = _require_session(session)
    project = _project_for_session(project_slug, api_key_id)
    with db() as conn:
        entity = conn.execute(
            "SELECT id FROM entities WHERE project_id = %s AND slug = %s",
            (project["id"], entity_slug),
        ).fetchone()
        if not entity:
            raise HTTPException(status_code=404, detail="entity not found")
        rows = conn.execute(
            """SELECT t.id, t.name FROM tags t
               JOIN entity_tags et ON et.tag_id = t.id
               WHERE et.entity_id = %s ORDER BY t.name""",
            (entity["id"],),
        ).fetchall()
    return [{"id": r["id"], "name": r["name"]} for r in rows]


class AddTagBody(BaseModel):
    name: str


@app.post("/projects/{project_slug}/entities/{entity_slug}/tags", status_code=201)
def add_entity_tag(
    project_slug: str,
    entity_slug: str,
    body: AddTagBody,
    session: str | None = Cookie(default=None, alias=COOKIE_NAME),
):
    name = body.name.strip().lower()
    if not name:
        raise HTTPException(status_code=400, detail="empty tag name")
    api_key_id, _ = _require_session(session)
    project = _project_for_session(project_slug, api_key_id)
    with db() as conn:
        entity = conn.execute(
            "SELECT id FROM entities WHERE project_id = %s AND slug = %s",
            (project["id"], entity_slug),
        ).fetchone()
        if not entity:
            raise HTTPException(status_code=404, detail="entity not found")
        # upsert tag
        conn.execute(
            "INSERT OR IGNORE INTO tags (project_id, name) VALUES (%s, %s)",
            (project["id"], name),
        )
        tag = conn.execute(
            "SELECT id FROM tags WHERE project_id = %s AND name = %s",
            (project["id"], name),
        ).fetchone()
        conn.execute(
            "INSERT OR IGNORE INTO entity_tags (entity_id, tag_id) VALUES (%s, %s)",
            (entity["id"], tag["id"]),
        )
    return {"id": tag["id"], "name": name}


@app.delete("/projects/{project_slug}/entities/{entity_slug}/tags/{tag_name}", status_code=204)
def remove_entity_tag(
    project_slug: str,
    entity_slug: str,
    tag_name: str,
    session: str | None = Cookie(default=None, alias=COOKIE_NAME),
):
    api_key_id, _ = _require_session(session)
    project = _project_for_session(project_slug, api_key_id)
    with db() as conn:
        entity = conn.execute(
            "SELECT id FROM entities WHERE project_id = %s AND slug = %s",
            (project["id"], entity_slug),
        ).fetchone()
        if not entity:
            raise HTTPException(status_code=404, detail="entity not found")
        tag = conn.execute(
            "SELECT id FROM tags WHERE project_id = %s AND name = %s",
            (project["id"], tag_name.strip().lower()),
        ).fetchone()
        if tag:
            conn.execute(
                "DELETE FROM entity_tags WHERE entity_id = %s AND tag_id = %s",
                (entity["id"], tag["id"]),
            )


# ---------------------------------------------------------------------------
# Assets
# ---------------------------------------------------------------------------

import hashlib
import mimetypes
from fastapi import UploadFile, File, Form
from fastapi.responses import FileResponse

ASSETS_ROOT = PROJECTS_ROOT  # assets live under projects/<slug>/assets/


def _asset_dir(project_slug: str) -> Path:
    return PROJECTS_ROOT / project_slug / "assets"


@app.post("/projects/{project_slug}/assets", status_code=201)
async def upload_asset(
    project_slug: str,
    file: UploadFile = File(...),
    session: str | None = Cookie(default=None, alias=COOKIE_NAME),
):
    api_key_id, _ = _require_session(session)
    project = _project_for_session(project_slug, api_key_id)

    data = await file.read()
    sha256 = hashlib.sha256(data).hexdigest()
    filename = Path(file.filename).name  # strip any path components
    rel_path = f"assets/{filename}"
    dest = _asset_dir(project_slug) / filename
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)

    mime = file.content_type or mimetypes.guess_type(filename)[0] or "application/octet-stream"

    with db() as conn:
        existing = conn.execute(
            "SELECT id FROM assets WHERE project_id = %s AND rel_path = %s",
            (project["id"], rel_path),
        ).fetchone()
        if existing:
            conn.execute(
                "UPDATE assets SET sha256 = %s, bytes = %s, mime = %s WHERE id = %s",
                (sha256, len(data), mime, existing["id"]),
            )
            asset_id = existing["id"]
        else:
            cur = conn.execute(
                "INSERT INTO assets (project_id, rel_path, mime, bytes, sha256, source) VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
                (project["id"], rel_path, mime, len(data), sha256, 'uploaded'),
            )
            asset_id = cur.fetchone()["id"]

    return {"id": asset_id, "rel_path": rel_path, "mime": mime, "bytes": len(data), "sha256": sha256}


@app.get("/projects/{project_slug}/assets")
def list_assets(
    project_slug: str,
    session: str | None = Cookie(default=None, alias=COOKIE_NAME),
):
    api_key_id, _ = _require_session(session)
    project = _project_for_session(project_slug, api_key_id)
    with db() as conn:
        rows = conn.execute(
            "SELECT id, rel_path, mime, bytes FROM assets WHERE project_id = %s",
            (project["id"],),
        ).fetchall()
    return [{"id": r["id"], "rel_path": r["rel_path"], "mime": r["mime"], "bytes": r["bytes"]} for r in rows]


@app.get("/projects/{project_slug}/assets/{asset_id}/file")
def get_asset_file(
    project_slug: str,
    asset_id: int,
    session: str | None = Cookie(default=None, alias=COOKIE_NAME),
):
    api_key_id, _ = _require_session(session)
    project = _project_for_session(project_slug, api_key_id)
    with db() as conn:
        row = conn.execute(
            "SELECT rel_path, mime FROM assets WHERE id = %s AND project_id = %s",
            (asset_id, project["id"]),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="asset not found")
    file_path = PROJECTS_ROOT / project_slug / row["rel_path"]
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="asset file missing from disk")
    return FileResponse(str(file_path), media_type=row["mime"])


@app.get("/projects/{project_slug}/entities/{entity_slug}/assets")
def list_entity_assets(
    project_slug: str,
    entity_slug: str,
    session: str | None = Cookie(default=None, alias=COOKIE_NAME),
):
    api_key_id, _ = _require_session(session)
    project = _project_for_session(project_slug, api_key_id)
    with db() as conn:
        entity = conn.execute(
            "SELECT id FROM entities WHERE project_id = %s AND slug = %s",
            (project["id"], entity_slug),
        ).fetchone()
        if not entity:
            raise HTTPException(status_code=404, detail="entity not found")
        rows = conn.execute(
            """SELECT a.id, a.rel_path, a.mime, a.bytes, ae.role
               FROM assets a JOIN asset_entities ae ON ae.asset_id = a.id
               WHERE ae.entity_id = %s""",
            (entity["id"],),
        ).fetchall()
    return [{"id": r["id"], "rel_path": r["rel_path"], "mime": r["mime"],
             "bytes": r["bytes"], "role": r["role"]} for r in rows]


class AssociateAssetBody(BaseModel):
    asset_id: int
    role: Optional[str] = None


@app.post("/projects/{project_slug}/entities/{entity_slug}/assets", status_code=201)
def associate_asset(
    project_slug: str,
    entity_slug: str,
    body: AssociateAssetBody,
    session: str | None = Cookie(default=None, alias=COOKIE_NAME),
):
    api_key_id, _ = _require_session(session)
    project = _project_for_session(project_slug, api_key_id)
    with db() as conn:
        entity = conn.execute(
            "SELECT id FROM entities WHERE project_id = %s AND slug = %s",
            (project["id"], entity_slug),
        ).fetchone()
        if not entity:
            raise HTTPException(status_code=404, detail="entity not found")
        asset = conn.execute(
            "SELECT id FROM assets WHERE id = %s AND project_id = %s",
            (body.asset_id, project["id"]),
        ).fetchone()
        if not asset:
            raise HTTPException(status_code=404, detail="asset not found")
        conn.execute(
            """INSERT INTO asset_entities (asset_id, entity_id, role) VALUES (%s, %s, %s)
               ON CONFLICT DO NOTHING""",
            (body.asset_id, entity["id"], body.role),
        )
    return {"ok": True}


@app.delete("/projects/{project_slug}/entities/{entity_slug}/assets/{asset_id}", status_code=204)
def disassociate_asset(
    project_slug: str,
    entity_slug: str,
    asset_id: int,
    session: str | None = Cookie(default=None, alias=COOKIE_NAME),
):
    api_key_id, _ = _require_session(session)
    project = _project_for_session(project_slug, api_key_id)
    with db() as conn:
        entity = conn.execute(
            "SELECT id FROM entities WHERE project_id = %s AND slug = %s",
            (project["id"], entity_slug),
        ).fetchone()
        if not entity:
            raise HTTPException(status_code=404, detail="entity not found")
        conn.execute(
            "DELETE FROM asset_entities WHERE asset_id = %s AND entity_id = %s",
            (asset_id, entity["id"]),
        )


# ---------------------------------------------------------------------------
# Image generation
# ---------------------------------------------------------------------------


import re as _re_img

_IMAGE_PROMPT_TEMPLATES: dict[str, str] = {
    "character": (
        "{art_style_clause}"
        "Full body character concept art, {description}, "
        "standing in a neutral A-pose or relaxed straight pose, "
        "entire body visible from head to toe with feet fully in frame, "
        "no cropping, clean isolated view, "
        "plain neutral light gray seamless background, "
        "studio lighting, soft even illumination, no shadows, "
        "no environment, no unrelated props or background elements, "
        "no text, no logos, no watermarks, "
        "highly detailed, clean lines, "
        "professional character design sheet style."
    ),
    "item": (
        "{art_style_clause}"
        "Full view game item sprite of {description}, "
        "centered, entire object clearly visible, "
        "isolated on plain light gray background, "
        "soft even illumination, minimal soft shadow, "
        "clean sharp details, no cropping, no background elements, "
        "no text, no logos, "
        "professional 2D inventory icon / sprite sheet style, "
        "crisp edges, high resolution game asset."
    ),
    "location": (
        "{art_style_clause}"
        "Wide horizontal full background image for a 2D point-and-click adventure game, "
        "{description}, "
        "complete scene fully visible edge to edge, no cropping, "
        "clean illustrative adventure game style, "
        "depth with clear layers (foreground, midground, distant background), "
        "soft natural lighting, "
        "empty of characters and interactive items, "
        "plain and neutral composition, "
        "highly detailed yet stylized, "
        "professional game environment art, "
        "no text, no logos."
    ),
}

_IMAGE_TYPES = {"location", "character", "item"}


def _build_image_prompt(project_slug: str, display_name: str, entity_type: str, body_text: str) -> str:
    if body_text:
        clean_body = _re_img.sub(r'@@([^@]+)@@|##([^#]+)##|~~([^~]+)~~|\?\?([^%s]+)\?\?', lambda m: next(g for g in m.groups() if g is not None), body_text)
        clean_body = _re_img.sub(r'\s+', ' ', clean_body).strip()
    else:
        clean_body = ""
    art_style = ""
    try:
        for gf in (PROJECTS_ROOT / project_slug / "content").glob("*.md"):
            gpost = fm.load(str(gf))
            if gpost.metadata.get("type") == "game":
                art_style = gpost.metadata.get("art_style", "").strip()
                break
    except Exception:
        pass
    description = clean_body if clean_body else display_name
    art_style_clause = f"Art style: {art_style}. " if art_style else ""
    return _IMAGE_PROMPT_TEMPLATES[entity_type].format(
        description=description,
        art_style_clause=art_style_clause,
    )


@app.get("/projects/{project_slug}/entities/{entity_slug}/image-prompt")
async def get_image_prompt(
    project_slug: str,
    entity_slug: str,
    session: str | None = Cookie(default=None, alias=COOKIE_NAME),
):
    """Return the image generation prompt without actually generating."""
    api_key_id, _ = _require_session(session)
    project = _project_for_session(project_slug, api_key_id)
    with db() as conn:
        entity = conn.execute(
            "SELECT id, type, display_name FROM entities WHERE project_id = %s AND slug = %s",
            (project["id"], entity_slug),
        ).fetchone()
    if not entity:
        raise HTTPException(status_code=404, detail="entity not found")
    if entity["type"] not in _IMAGE_TYPES:
        raise HTTPException(status_code=400, detail="image generation only supported for location, character, and item entities")
    post = _read_entity_file(project_slug, entity_slug)
    prompt = _build_image_prompt(project_slug, entity["display_name"], entity["type"], post.content.strip())
    return {"prompt": prompt}



# ---------------------------------------------------------------------------
# Voice registration (voxpop 8001)
# ---------------------------------------------------------------------------

VOXPOP_URL = "http://purpose-voxpop:8001"


@app.get("/projects/{project_slug}/voices")
async def list_voices(
    project_slug: str,
    session: str | None = Cookie(default=None, alias=COOKIE_NAME),
):
    """Return the set of voice names registered on voxpop for this project."""
    import httpx as _httpx
    _require_session(session)
    async with _httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(f"{VOXPOP_URL}/voices")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"voxpop: {resp.text[:200]}")
    return resp.json()


@app.post("/projects/{project_slug}/characters/{character_slug}/register-voice", status_code=200)
async def register_voice(
    project_slug: str,
    character_slug: str,
    request: Request,
    session: str | None = Cookie(default=None, alias=COOKIE_NAME),
):
    """Upload a WAV reference clip and register it with voxpop under the character slug."""
    import httpx as _httpx
    api_key_id, _ = _require_session(session)
    _project_for_session(project_slug, api_key_id)

    audio_bytes = await request.body()
    if not audio_bytes:
        raise HTTPException(status_code=422, detail="audio body required")

    async with _httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{VOXPOP_URL}/voices/{character_slug}",
            files={"file": ("voice.wav", audio_bytes, "application/octet-stream")},
        )
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"voxpop: {resp.text[:200]}")
    return resp.json()


@app.delete("/projects/{project_slug}/characters/{character_slug}/register-voice", status_code=200)
async def delete_voice(
    project_slug: str,
    character_slug: str,
    session: str | None = Cookie(default=None, alias=COOKIE_NAME),
):
    import httpx as _httpx
    api_key_id, _ = _require_session(session)
    _project_for_session(project_slug, api_key_id)
    async with _httpx.AsyncClient(timeout=10) as client:
        resp = await client.delete(f"{VOXPOP_URL}/voices/{character_slug}")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"voxpop: {resp.text[:200]}")
    return resp.json()


class GenerateVoiceBody(BaseModel):
    line_id: str
    line_index: int
    text: str
    speaker_slug: str     # character slug - must have a registered voice on voxpop



@app.post("/projects/{project_slug}/entities/{entity_slug}/record-line", status_code=201)
async def record_line(
    project_slug: str,
    entity_slug: str,
    line_id: str,
    line_index: int,
    request: Request,
    session: str | None = Cookie(default=None, alias=COOKIE_NAME),
):
    """Save a recorded WAV directly as a line audio asset (no enhancement)."""
    import hashlib as _hashlib, json as _json

    api_key_id, _ = _require_session(session)
    project = _project_for_session(project_slug, api_key_id)

    wav_bytes = await request.body()
    if not wav_bytes:
        raise HTTPException(status_code=422, detail="audio body required")

    sha256 = _hashlib.sha256(wav_bytes).hexdigest()
    assets_dir = PROJECTS_ROOT / project_slug / "assets"
    assets_dir.mkdir(exist_ok=True)
    filename = f"recorded_{entity_slug}_{line_id}_{line_index}_{sha256[:8]}.wav"
    (assets_dir / filename).write_bytes(wav_bytes)
    rel_path = f"assets/{filename}"

    with db() as conn:
        existing = conn.execute(
            "SELECT id FROM assets WHERE project_id = %s AND sha256 = %s",
            (project["id"], sha256),
        ).fetchone()
        if existing:
            asset_id = existing["id"]
        else:
            cur = conn.execute(
                "INSERT INTO assets (project_id, rel_path, mime, bytes, sha256, source) VALUES (%s,%s,%s,%s,%s,%s) RETURNING id",
                (project["id"], rel_path, "audio/wav", len(wav_bytes), sha256, 'uploaded'),
            )
            asset_id = cur.fetchone()["id"]
        conv_entity = conn.execute(
            "SELECT id FROM entities WHERE project_id = %s AND slug = %s",
            (project["id"], entity_slug),
        ).fetchone()
        if conv_entity:
            conn.execute(
                "INSERT OR IGNORE INTO asset_entities (asset_id, entity_id, role) VALUES (%s,%s,%s)",
                (asset_id, conv_entity["id"], "recorded"),
            )

    conv_post = _read_entity_file(project_slug, entity_slug)
    try:
        conv_data = _json.loads(conv_post.content) if conv_post.content.strip() else {}
    except Exception:
        conv_data = {}

    def _patch(items: list, tid: str, idx: int) -> bool:
        for item in items:
            if not isinstance(item, dict): continue
            if item.get("id") == tid:
                ll = item.get("lines", [])
                if 0 <= idx < len(ll):
                    ll[idx]["audio"] = asset_id
                    return True
            if _patch(item.get("response_menu", []), tid, idx): return True
        return False

    patched = False
    for g in conv_data.get("greetings", []):
        if isinstance(g, dict) and g.get("id") == line_id:
            ll = g.get("lines", [])
            if 0 <= line_index < len(ll):
                ll[line_index]["audio"] = asset_id
                patched = True
                break
    if not patched:
        _patch(conv_data.get("menu", []), line_id, line_index)

    _write_entity_file(
        project_slug, entity_slug,
        conv_post.metadata.get("display_name", entity_slug),
        "conversation", _json.dumps(conv_data, indent=2),
        extra_meta={k: v for k, v in conv_post.metadata.items()
                    if k not in ("slug", "type", "display_name")},
    )
    return {"asset_id": asset_id, "filename": filename}



@app.post("/projects/{project_slug}/entities/{entity_slug}/enhance-line", status_code=201)
async def enhance_line(
    project_slug: str,
    entity_slug: str,
    line_id: str,
    line_index: int,
    asset_id: int,
    session: str | None = Cookie(default=None, alias=COOKIE_NAME),
):
    """Denoise an existing line audio asset via DeepFilterNet, save as new asset, patch conversation body."""
    import httpx as _httpx, hashlib as _hashlib, json as _json

    api_key_id, _ = _require_session(session)
    project = _project_for_session(project_slug, api_key_id)

    # Fetch the source asset
    with db() as conn:
        asset_row = conn.execute(
            "SELECT rel_path, mime FROM assets WHERE id = %s AND project_id = %s",
            (asset_id, project["id"]),
        ).fetchone()
    if not asset_row:
        raise HTTPException(status_code=404, detail="asset not found")

    asset_path = PROJECTS_ROOT / project_slug / asset_row["rel_path"]
    if not asset_path.exists():
        raise HTTPException(status_code=404, detail="asset file not found on disk")

    wav_in = asset_path.read_bytes()

    # Send to DeepFilterNet
    async with _httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(
            "http://purpose-voxpop:8002/denoise",
            files={"file": ("audio.wav", wav_in, "audio/wav")},
            data={"format": "wav"},
        )
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"denoise: {resp.text[:200]}")

    wav_out = resp.content
    sha256 = _hashlib.sha256(wav_out).hexdigest()

    assets_dir = PROJECTS_ROOT / project_slug / "assets"
    assets_dir.mkdir(exist_ok=True)
    filename = f"enhanced_{entity_slug}_{line_id}_{line_index}_{sha256[:8]}.wav"
    (assets_dir / filename).write_bytes(wav_out)
    rel_path = f"assets/{filename}"

    with db() as conn:
        existing = conn.execute(
            "SELECT id FROM assets WHERE project_id = %s AND sha256 = %s",
            (project["id"], sha256),
        ).fetchone()
        if existing:
            new_asset_id = existing["id"]
        else:
            cur = conn.execute(
                "INSERT INTO assets (project_id, rel_path, mime, bytes, sha256, source) VALUES (%s,%s,%s,%s,%s,%s) RETURNING id",
                (project["id"], rel_path, "audio/wav", len(wav_out), sha256, 'uploaded'),
            )
            new_asset_id = cur.fetchone()["id"]
        conv_entity = conn.execute(
            "SELECT id FROM entities WHERE project_id = %s AND slug = %s",
            (project["id"], entity_slug),
        ).fetchone()
        if conv_entity:
            conn.execute(
                "INSERT OR IGNORE INTO asset_entities (asset_id, entity_id, role) VALUES (%s,%s,%s)",
                (new_asset_id, conv_entity["id"], "enhanced"),
            )

    # Patch audio field on the line
    conv_post = _read_entity_file(project_slug, entity_slug)
    try:
        conv_data = _json.loads(conv_post.content) if conv_post.content.strip() else {}
    except Exception:
        conv_data = {}

    def _patch(items: list, tid: str, idx: int) -> bool:
        for item in items:
            if not isinstance(item, dict): continue
            if item.get("id") == tid:
                ll = item.get("lines", [])
                if 0 <= idx < len(ll):
                    ll[idx]["audio"] = new_asset_id
                    return True
            if _patch(item.get("response_menu", []), tid, idx): return True
        return False

    patched = False
    for g in conv_data.get("greetings", []):
        if isinstance(g, dict) and g.get("id") == line_id:
            ll = g.get("lines", [])
            if 0 <= line_index < len(ll):
                ll[line_index]["audio"] = new_asset_id
                patched = True
                break
    if not patched:
        _patch(conv_data.get("menu", []), line_id, line_index)

    _write_entity_file(
        project_slug, entity_slug,
        conv_post.metadata.get("display_name", entity_slug),
        "conversation", _json.dumps(conv_data, indent=2),
        extra_meta={k: v for k, v in conv_post.metadata.items()
                    if k not in ("slug", "type", "display_name")},
    )
    return {"asset_id": new_asset_id, "filename": filename}


@app.post("/projects/{project_slug}/entities/{entity_slug}/generate-voice", status_code=201)
async def generate_voice(
    project_slug: str,
    entity_slug: str,
    body: GenerateVoiceBody,
    session: str | None = Cookie(default=None, alias=COOKIE_NAME),
):
    """Generate TTS audio for a conversation line via voxpop (8001), save as asset."""
    import httpx as _httpx, hashlib as _hashlib

    api_key_id, _ = _require_session(session)
    project = _project_for_session(project_slug, api_key_id)

    vox_payload: dict = {"voice": body.speaker_slug, "text": body.text, "format": "wav", "style_strength": 1.9}

    async with _httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(f"{VOXPOP_URL}/synthesise", json=vox_payload)
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"voxpop: {resp.text[:200]}")

    wav_bytes = resp.content
    sha256 = _hashlib.sha256(wav_bytes).hexdigest()

    # Save WAV to assets directory
    assets_dir = PROJECTS_ROOT / project_slug / "assets"
    assets_dir.mkdir(exist_ok=True)
    filename = f"voice_{entity_slug}_{body.line_id}_{body.line_index}_{sha256[:8]}.wav"
    asset_path = assets_dir / filename
    asset_path.write_bytes(wav_bytes)
    rel_path = f"assets/{filename}"

    # Insert or update asset row
    with db() as conn:
        existing = conn.execute(
            "SELECT id FROM assets WHERE project_id = %s AND sha256 = %s",
            (project["id"], sha256),
        ).fetchone()
        if existing:
            asset_id = existing["id"]
        else:
            cur = conn.execute(
                "INSERT INTO assets (project_id, rel_path, mime, bytes, sha256, source) VALUES (%s,%s,%s,%s,%s,%s) RETURNING id",
                (project["id"], rel_path, "audio/wav", len(wav_bytes), sha256, 'generated'),
            )
            asset_id = cur.fetchone()["id"]

        # Associate with the conversation entity (role = voice)
        conv_entity = conn.execute(
            "SELECT id FROM entities WHERE project_id = %s AND slug = %s",
            (project["id"], entity_slug),
        ).fetchone()
        if conv_entity:
            conn.execute(
                "INSERT OR IGNORE INTO asset_entities (asset_id, entity_id, role) VALUES (%s,%s,%s)",
                (asset_id, conv_entity["id"], "voice"),
            )

    # Update the audio field on the specific line in the conversation body
    import json as _json
    conv_post = _read_entity_file(project_slug, entity_slug)
    try:
        conv_data = _json.loads(conv_post.content) if conv_post.content.strip() else {}
    except Exception:
        conv_data = {}

    def _patch_line(items: list, target_id: str, line_idx: int) -> bool:
        for item in items:
            if not isinstance(item, dict):
                continue
            if item.get("id") == target_id:
                lines_list = item.get("lines", [])
                if 0 <= line_idx < len(lines_list):
                    lines_list[line_idx]["audio"] = asset_id
                    return True
            # recurse into response_menu
            if _patch_line(item.get("response_menu", []), target_id, line_idx):
                return True
        return False

    patched = False
    for greeting in conv_data.get("greetings", []):
        if isinstance(greeting, dict) and greeting.get("id") == body.line_id:
            lines_list = greeting.get("lines", [])
            if 0 <= body.line_index < len(lines_list):
                lines_list[body.line_index]["audio"] = asset_id
                patched = True
                break

    if not patched:
        _patch_line(conv_data.get("menu", []), body.line_id, body.line_index)

    new_body = _json.dumps(conv_data, indent=2)
    _write_entity_file(project_slug, entity_slug, conv_post.metadata.get("display_name", entity_slug),
                       "conversation", new_body,
                       extra_meta={k: v for k, v in conv_post.metadata.items()
                                   if k not in ("slug", "type", "display_name")})

    return {"asset_id": asset_id, "filename": filename}


@app.post("/projects/{project_slug}/entities/{entity_slug}/generate-image", status_code=201)
async def generate_image(
    project_slug: str,
    entity_slug: str,
    session: str | None = Cookie(default=None, alias=COOKIE_NAME),
):
    import httpx, hashlib, mimetypes as _mimetypes, datetime

    api_key_id, _ = _require_session(session)
    project = _project_for_session(project_slug, api_key_id)

    with db() as conn:
        entity = conn.execute(
            "SELECT id, type, display_name FROM entities WHERE project_id = %s AND slug = %s",
            (project["id"], entity_slug),
        ).fetchone()
    if not entity:
        raise HTTPException(status_code=404, detail="entity not found")
    if entity["type"] not in _IMAGE_TYPES:
        raise HTTPException(status_code=400, detail="image generation only supported for location, character, and item entities")

    xai_key = _load_secret("XAI_API_KEY")
    if not xai_key:
        raise HTTPException(status_code=500, detail="XAI_API_KEY not configured")

    post = _read_entity_file(project_slug, entity_slug)
    body_text = post.content.strip()

    prompt = _build_image_prompt(project_slug, entity["display_name"], entity["type"], body_text)

    log.info("Generating image for %s/%s: %s", project_slug, entity_slug, prompt[:80])
    # Log full prompt and response to dedicated file for inspection
    import datetime as _dt
    _img_log = Path("/workspace/data/image_generation.log")
    def _img_log_write(entry: str) -> None:
        with _img_log.open("a", encoding="utf-8") as f:
            f.write(entry + "\n")
    _ts = _dt.datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S UTC")
    _img_log_write(f"\n--- {_ts} | {project_slug}/{entity_slug} ---")
    _img_log_write(f"PROMPT: {prompt}")

    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(
            "https://api.x.ai/v1/images/generations",
            headers={"Authorization": f"Bearer {xai_key}", "Content-Type": "application/json"},
            json={"model": "grok-imagine-image", "prompt": prompt, "n": 1},
        )
    if resp.status_code != 200:
        log.error("xAI image generation failed: %s %s", resp.status_code, resp.text)
        _img_log_write(f"RESPONSE ERROR {resp.status_code}: {resp.text}")
        try:
            xai_detail = resp.json().get("error") or resp.text
        except Exception:
            xai_detail = resp.text
        raise HTTPException(status_code=502, detail=f"xAI: {xai_detail}")

    result = resp.json()
    image_url = result["data"][0]["url"]

    # Download the image
    async with httpx.AsyncClient(timeout=60) as client:
        img_resp = await client.get(image_url)
    if img_resp.status_code != 200:
        raise HTTPException(status_code=502, detail="failed to download generated image")

    image_data = img_resp.content
    sha256 = hashlib.sha256(image_data).hexdigest()
    timestamp = datetime.datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    filename = f"{entity_slug}_generated_{timestamp}.jpg"
    rel_path = f"assets/{filename}"
    dest = _asset_dir(project_slug) / filename
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(image_data)

    mime = "image/jpeg"
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO assets (project_id, rel_path, mime, bytes, sha256, source) VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
            (project["id"], rel_path, mime, len(image_data), sha256, 'generated'),
        )
        asset_id = cur.fetchone()["id"]
        conn.execute(
            "INSERT INTO asset_entities (asset_id, entity_id, role) VALUES (%s, %s, %s) ON CONFLICT DO NOTHING",
            (asset_id, entity["id"], "generated"),
        )

    log.info("Image generated and saved: %s (asset %d)", filename, asset_id)
    _img_log_write(f"RESPONSE OK: saved as {filename} (asset {asset_id})")
    return {"id": asset_id, "rel_path": rel_path, "mime": mime, "bytes": len(image_data), "sha256": sha256}



# ---------------------------------------------------------------------------
# Character facing and walk frame generation
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Character part generation and walk cycle rendering
# ---------------------------------------------------------------------------

# Part types in composite z-order (back to front, mirrored parts generated once,
# flipped at render time for far side)
_PART_TYPES = ["hair", "head", "torso", "upper_arm", "lower_arm", "hand",
               "upper_leg", "lower_leg", "foot"]

# Pivot points as fraction of part image (attach_x, attach_y) - point that snaps
# to the parent's child_anchor. Also defines child_anchor for the next part down.
# attach: where this part attaches to its parent
# child: where the next part in chain attaches on this part
_PART_PIVOTS = {
    "hair":      {"attach": (0.5, 1.0), "child": None},
    "head":      {"attach": (0.5, 0.9), "child": (0.5, 1.0)},   # child=neck bottom
    "torso":     {"attach": (0.5, 0.0), "child": (0.5, 1.0)},   # attach=neck top, child=hip
    "upper_arm": {"attach": (0.5, 0.0), "child": (0.5, 1.0)},
    "lower_arm": {"attach": (0.5, 0.0), "child": (0.5, 1.0)},
    "hand":      {"attach": (0.5, 0.0), "child": None},
    "upper_leg": {"attach": (0.5, 0.0), "child": (0.5, 1.0)},
    "lower_leg": {"attach": (0.5, 0.0), "child": (0.5, 1.0)},
    "foot":      {"attach": (0.5, 0.0), "child": None},
}

# Torso anchor points for arm and leg roots (as fraction of torso image)
_TORSO_ANCHORS = {
    "shoulder": (0.5, 0.12),   # where upper_arm attaches
    "hip":      (0.5, 0.88),   # where upper_leg attaches
}

# Gait keyframes: 8 frames, angles in degrees for each articulated part.
# Positive = clockwise rotation. near_ = near side (rendered on top), far_ = far side.
# Torso: (sway_x_px, bob_y_px) translation offsets
_GAIT_STYLES = {
    "shuffle": {
        # Very small range, flat-footed, minimal arm swing - elderly/tired gait
        "torso_bob":     [ 0, -3, -5, -3,  0, -3, -5, -3],
        "torso_sway":    [ 0,  2,  0, -2,  0,  2,  0, -2],
        "near_upper_leg":[ 8, 15,  5, -8,-15, -5,  0,  5],
        "near_lower_leg":[ 3,  5,  2, -2, -5, -2,  0,  2],
        "near_foot":     [-3, -5, -2,  2,  5,  2,  0, -2],
        "far_upper_leg": [-8,-15, -5,  8, 15,  5,  0, -5],
        "far_lower_leg": [-3, -5, -2,  2,  5,  2,  0, -2],
        "far_foot":      [ 3,  5,  2, -2, -5, -2,  0,  2],
        "near_upper_arm":[ 5,  8,  3, -5, -8, -3,  0,  3],
        "near_lower_arm":[ 2,  4,  1, -2, -4, -1,  0,  1],
        "far_upper_arm": [-5, -8, -3,  5,  8,  3,  0, -3],
        "far_lower_arm": [-2, -4, -1,  2,  4,  1,  0, -1],
        "head_bob":      [ 0, -2, -3, -2,  0, -2, -3, -2],
    },
    "stride": {
        # Full confident stride
        "torso_bob":     [ 0, -5,-10, -5,  0, -5,-10, -5],
        "torso_sway":    [ 0,  4,  0, -4,  0,  4,  0, -4],
        "near_upper_leg":[20, 35, 10,-20,-35,-10,  0, 10],
        "near_lower_leg":[ 5, 12,  4, -5,-12, -4,  0,  4],
        "near_foot":     [-5,-12, -4,  5, 12,  4,  0, -4],
        "far_upper_leg": [-20,-35,-10, 20, 35, 10,  0,-10],
        "far_lower_leg": [-5,-12, -4,  5, 12,  4,  0, -4],
        "far_foot":      [ 5, 12,  4, -5,-12, -4,  0,  4],
        "near_upper_arm":[-20,-35,-10, 20, 35, 10,  0,-10],
        "near_lower_arm":[-5,-10, -3,  5, 10,  3,  0, -3],
        "far_upper_arm": [20, 35, 10,-20,-35,-10,  0, 10],
        "far_lower_arm": [ 5, 10,  3, -5,-10, -3,  0,  3],
        "head_bob":      [ 0, -4, -7, -4,  0, -4, -7, -4],
    },
    "jog": {
        # Bouncy run, larger angles, more bob
        "torso_bob":     [ 0,-8,-14, -8,  0, -8,-14, -8],
        "torso_sway":    [ 0,  5,  0, -5,  0,  5,  0, -5],
        "near_upper_leg":[30, 50, 15,-30,-50,-15,  0, 15],
        "near_lower_leg":[10, 20,  8,-10,-20, -8,  0,  8],
        "near_foot":     [-8,-15, -6,  8, 15,  6,  0, -6],
        "far_upper_leg": [-30,-50,-15, 30, 50, 15,  0,-15],
        "far_lower_leg": [-10,-20, -8, 10, 20,  8,  0, -8],
        "far_foot":      [ 8, 15,  6, -8,-15, -6,  0,  6],
        "near_upper_arm":[-30,-50,-15, 30, 50, 15,  0,-15],
        "near_lower_arm":[-10,-18, -6, 10, 18,  6,  0, -6],
        "far_upper_arm": [30, 50, 15,-30,-50,-15,  0, 15],
        "far_lower_arm": [10, 18,  6,-10,-18, -6,  0,  6],
        "head_bob":      [ 0, -6,-10, -6,  0, -6,-10, -6],
    },
    "waddle": {
        # Wide side-to-side, minimal leg lift - penguin/rotund gait
        "torso_bob":     [ 0, -2, -4, -2,  0, -2, -4, -2],
        "torso_sway":    [ 0,  8,  0, -8,  0,  8,  0, -8],
        "near_upper_leg":[ 5, 10,  3, -5,-10, -3,  0,  3],
        "near_lower_leg":[ 1,  2,  1, -1, -2, -1,  0,  1],
        "near_foot":     [-1, -2, -1,  1,  2,  1,  0, -1],
        "far_upper_leg": [-5,-10, -3,  5, 10,  3,  0, -3],
        "far_lower_leg": [-1, -2, -1,  1,  2,  1,  0, -1],
        "far_foot":      [ 1,  2,  1, -1, -2, -1,  0,  1],
        "near_upper_arm":[ 8, 12,  4, -8,-12, -4,  0,  4],
        "near_lower_arm":[ 3,  5,  2, -3, -5, -2,  0,  2],
        "far_upper_arm": [-8,-12, -4,  8, 12,  4,  0, -4],
        "far_lower_arm": [-3, -5, -2,  3,  5,  2,  0, -3],
        "head_bob":      [ 0, -1, -2, -1,  0, -1, -2, -1],
    },
}

# Prompt templates per part type.
# {art_style}, {char_desc}, {skin_tone} are substituted at call time.
_PART_PROMPTS = {
    "hair": (
        "Isolated hair only, no face, no neck, no body. "
        "Side profile view facing left. "
        "The hair of this character: {char_desc}. "
        "Hair fills the full height of the image from crown to nape, centred horizontally. "
        "Plain neutral light gray seamless background. No skin, no clothing, no other body parts. "
        "Art style: {art_style}."
    ),
    "head": (
        "Isolated head only, no neck, no body, no hair. "
        "Side profile view facing left. "
        "The head and face of this character: {char_desc}. "
        "Head fills the full height of the image from chin to crown, centred horizontally. "
        "Skin tone: {skin_tone}. "
        "Plain neutral light gray seamless background. No hair, no clothing. "
        "Art style: {art_style}."
    ),
    "torso": (
        "Isolated torso only - from neck to hips, no head, no limbs. "
        "Side profile view facing left. "
        "The torso and clothing of this character: {char_desc}. "
        "Torso fills the full height of the image from neck top to hip bottom, centred horizontally. "
        "Skin tone: {skin_tone}. "
        "Plain neutral light gray seamless background. No head, no arms, no legs. "
        "Art style: {art_style}."
    ),
    "upper_arm": (
        "Isolated upper arm only - from shoulder to elbow, no other body parts. "
        "Side profile view facing left, arm hanging straight down. "
        "The arm and sleeve of this character: {char_desc}. "
        "Upper arm fills the full height of the image from shoulder top to elbow bottom, centred horizontally. "
        "Skin tone: {skin_tone}. "
        "Plain neutral light gray seamless background. "
        "Art style: {art_style}."
    ),
    "lower_arm": (
        "Isolated lower arm only - from elbow to wrist, no other body parts. "
        "Side profile view facing left, arm hanging straight down. "
        "The forearm and sleeve cuff of this character: {char_desc}. "
        "Lower arm fills the full height of the image from elbow top to wrist bottom, centred horizontally. "
        "Skin tone: {skin_tone}. "
        "Plain neutral light gray seamless background. "
        "Art style: {art_style}."
    ),
    "hand": (
        "Isolated hand only - from wrist to fingertips, no arm, no other body parts. "
        "Side profile view facing left, hand relaxed and open. "
        "The hand of this character: {char_desc}. "
        "Hand fills the full height of the image from wrist top to fingertip bottom, centred horizontally. "
        "Skin tone: {skin_tone}. "
        "Plain neutral light gray seamless background. "
        "Art style: {art_style}."
    ),
    "upper_leg": (
        "Isolated upper leg only - from hip to knee, no other body parts. "
        "Side profile view facing left, leg straight and vertical. "
        "The upper leg and clothing of this character: {char_desc}. "
        "Upper leg fills the full height of the image from hip top to knee bottom, centred horizontally. "
        "Skin tone: {skin_tone}. "
        "Plain neutral light gray seamless background. "
        "Art style: {art_style}."
    ),
    "lower_leg": (
        "Isolated lower leg only - from knee to ankle, no other body parts. "
        "Side profile view facing left, leg straight and vertical. "
        "The lower leg and clothing of this character: {char_desc}. "
        "Lower leg fills the full height of the image from knee top to ankle bottom, centred horizontally. "
        "Skin tone: {skin_tone}. "
        "Plain neutral light gray seamless background. "
        "Art style: {art_style}."
    ),
    "foot": (
        "Isolated foot and footwear only - from ankle to toe, no other body parts. "
        "Side profile view facing left, foot flat on an invisible ground plane. "
        "The foot and footwear of this character: {char_desc}. "
        "Foot fills the full height of the image from ankle top to sole bottom, centred horizontally. "
        "Plain neutral light gray seamless background. "
        "Art style: {art_style}."
    ),
}


def _get_portrait_bytes(project_slug: str, entity_id: int) -> bytes | None:
    """Return bytes of the portrait asset for a character, or None."""
    with db() as conn:
        row = conn.execute(
            "SELECT a.rel_path FROM assets a "
            "JOIN asset_entities ae ON ae.asset_id = a.id "
            "WHERE ae.entity_id = %s AND ae.role = 'portrait' "
            "ORDER BY a.id DESC LIMIT 1",
            (entity_id,),
        ).fetchone()
    if not row:
        return None
    path = _asset_dir(project_slug) / Path(row["rel_path"]).name
    return path.read_bytes() if path.exists() else None


def _get_part_bytes(project_slug: str, entity_id: int, part_type: str) -> bytes | None:
    with db() as conn:
        row = conn.execute(
            "SELECT a.rel_path FROM assets a JOIN asset_entities ae ON ae.asset_id=a.id "
            "WHERE ae.entity_id=%s AND ae.role=%s ORDER BY a.id DESC LIMIT 1",
            (entity_id, f"part_{part_type}"),
        ).fetchone()
    if not row:
        return None
    path = _asset_dir(project_slug) / Path(row["rel_path"]).name
    return path.read_bytes() if path.exists() else None


def _extract_skin_tone(image_bytes: bytes) -> str:
    """Extract dominant skin-range colour from image bytes, return as #rrggbb hex."""
    import io as _io
    from PIL import Image as _Img
    img = _Img.open(_io.BytesIO(image_bytes)).convert("RGB")
    img = img.resize((64, 64))
    pixels = list(img.getdata())
    # Skin heuristic: r > 80, r > g > b, r-b > 20
    skin = [p for p in pixels if p[0] > 80 and p[0] > p[1] > p[2] and p[0] - p[2] > 20]
    if not skin:
        return "#c8a882"  # fallback neutral
    r = sum(p[0] for p in skin) // len(skin)
    g = sum(p[1] for p in skin) // len(skin)
    b = sum(p[2] for p in skin) // len(skin)
    return f"#{r:02x}{g:02x}{b:02x}"


def _get_art_style(project_slug: str, project_id: int) -> str:
    with db() as conn:
        row = conn.execute(
            "SELECT slug FROM entities WHERE project_id=%s AND type='game'", (project_id,)
        ).fetchone()
    if not row:
        return ""
    try:
        gpost = _read_entity_file(project_slug, row["slug"])
        return gpost.metadata.get("art_style", "").strip()
    except Exception:
        return ""


@app.post("/projects/{project_slug}/entities/{entity_slug}/generate-part", status_code=201)
async def generate_part(
    project_slug: str,
    entity_slug: str,
    part_type: str,
    session: str | None = Cookie(default=None, alias=COOKIE_NAME),
):
    import datetime as _dt
    if part_type not in _PART_TYPES:
        raise HTTPException(status_code=400, detail=f"part_type must be one of {_PART_TYPES}")
    api_key_id, _ = _require_session(session)
    project = _project_for_session(project_slug, api_key_id)
    with db() as conn:
        entity = conn.execute(
            "SELECT id, type, display_name FROM entities WHERE project_id=%s AND slug=%s",
            (project["id"], entity_slug),
        ).fetchone()
    if not entity or entity["type"] != "character":
        raise HTTPException(status_code=404, detail="character entity not found")

    # Enforce head-first rule for non-head parts
    if part_type != "head":
        head_bytes = _get_part_bytes(project_slug, entity["id"], "head")
        if not head_bytes:
            raise HTTPException(status_code=400, detail="generate head first")

    xai_key = _load_secret("XAI_API_KEY")
    if not xai_key:
        raise HTTPException(status_code=500, detail="XAI_API_KEY not configured")

    post = _read_entity_file(project_slug, entity_slug)
    char_desc = post.metadata.get("physical_appearance", "").strip() or entity["display_name"]
    skin_tone = post.metadata.get("skin_tone", "#c8a882").strip()
    art_style = _get_art_style(project_slug, project["id"])

    prompt = _PART_PROMPTS[part_type].format(
        char_desc=char_desc,
        skin_tone=skin_tone,
        art_style=art_style,
    )

    # Reference image selection:
    # - head: use portrait asset if available, else fall back to generations (no ref)
    # - all other parts: use the generated head as reference
    if part_type == "head":
        ref_bytes = _get_portrait_bytes(project_slug, entity["id"])
    else:
        ref_bytes = _get_part_bytes(project_slug, entity["id"], "head")

    if ref_bytes:
        image_data = await _xai_edit_async(xai_key, prompt, ref_bytes)
    else:
        # head with no portrait yet - use generations endpoint
        import httpx as _httpx
        async with _httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                "https://api.x.ai/v1/images/generations",
                headers={"Authorization": f"Bearer {xai_key}", "Content-Type": "application/json"},
                json={"model": "grok-imagine-image", "prompt": prompt, "n": 1},
            )
        if resp.status_code != 200:
            try:
                detail = resp.json().get("error") or resp.text
            except Exception:
                detail = resp.text
            raise HTTPException(status_code=502, detail=f"xAI: {detail}")
        img_url = resp.json()["data"][0]["url"]
        async with _httpx.AsyncClient(timeout=60) as client:
            dl = await client.get(img_url)
        image_data = dl.content

    ts = _dt.datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    filename = f"{entity_slug}_part_{part_type}_{ts}.jpg"
    role = f"part_{part_type}"
    result = await _save_character_asset(project, entity, project_slug, image_data, filename, role)

    # After head generation: extract and store skin tone
    if part_type == "head":
        skin_tone = _extract_skin_tone(image_data)
        import frontmatter as _fm
        try:
            fpath = _entity_path(project_slug, entity_slug)
            fpost = _fm.load(str(fpath))
            fpost.metadata["skin_tone"] = skin_tone
            fpath.write_text(_fm.dumps(fpost))
        except Exception:
            pass
        result["skin_tone"] = skin_tone

    return result


@app.post("/projects/{project_slug}/entities/{entity_slug}/render-walk", status_code=201)
async def render_walk(
    project_slug: str,
    entity_slug: str,
    gait: str = "shuffle",
    session: str | None = Cookie(default=None, alias=COOKIE_NAME),
):
    import io as _io, math as _math, datetime as _dt
    from PIL import Image as _Img, ImageOps as _IOps

    if gait not in _GAIT_STYLES:
        raise HTTPException(status_code=400, detail=f"gait must be one of {list(_GAIT_STYLES.keys())}")
    api_key_id, _ = _require_session(session)
    project = _project_for_session(project_slug, api_key_id)
    with db() as conn:
        entity = conn.execute(
            "SELECT id, type, display_name FROM entities WHERE project_id=%s AND slug=%s",
            (project["id"], entity_slug),
        ).fetchone()
    if not entity or entity["type"] != "character":
        raise HTTPException(status_code=404, detail="character entity not found")

    # Load all part images - require at minimum head + torso + upper_leg + lower_leg + foot
    required = {"head", "torso", "upper_leg", "lower_leg", "foot"}
    parts: dict[str, _Img.Image] = {}
    for pt in _PART_TYPES:
        b = _get_part_bytes(project_slug, entity["id"], pt)
        if b:
            parts[pt] = _Img.open(_io.BytesIO(b)).convert("RGBA")
        elif pt in required:
            raise HTTPException(status_code=400, detail=f"missing required part: {pt}")

    keyframes = _GAIT_STYLES[gait]
    N_FRAMES = 8

    # Canonical part dimensions: scale all parts relative to torso height
    torso = parts["torso"]
    tw, th = torso.size

    # Frame canvas: 3x torso height tall, 2x torso width wide - generous padding
    canvas_h = th * 3
    canvas_w = tw * 2
    # Torso root position (top of torso)
    torso_root_x = canvas_w // 2
    torso_root_y = canvas_h // 4

    def _rotate_part(img: _Img.Image, angle_deg: float, pivot_frac: tuple) -> tuple:
        """Rotate image around pivot_frac (fx, fy), return (rotated_img, new_pivot_px)."""
        w, h = img.size
        px = int(pivot_frac[0] * w)
        py = int(pivot_frac[1] * h)
        # Expand canvas so nothing is clipped during rotation
        expanded = _Img.new("RGBA", (w * 3, h * 3), (0, 0, 0, 0))
        expanded.paste(img, (w, h))
        rotated = expanded.rotate(-angle_deg, center=(w + px, h + py), expand=False)
        return rotated, (w + px, h + py)

    def _paste_part(canvas: _Img.Image, part_img: _Img.Image, anchor_canvas: tuple,
                    part_attach_frac: tuple) -> tuple:
        """Paste part_img onto canvas so that part_attach_frac aligns with anchor_canvas.
        Returns the part's child anchor in canvas coordinates."""
        pw, ph = part_img.size
        ax = int(part_attach_frac[0] * pw)
        ay = int(part_attach_frac[1] * ph)
        paste_x = anchor_canvas[0] - ax
        paste_y = anchor_canvas[1] - ay
        canvas.paste(part_img, (paste_x, paste_y), part_img)
        return (paste_x, paste_y, pw, ph)

    frames = []
    for f in range(N_FRAMES):
        kf = {k: v[f] for k, v in keyframes.items()}
        canvas = _Img.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))

        # Torso position with bob/sway
        tx = torso_root_x + kf["torso_sway"]
        ty = torso_root_y + kf["torso_bob"]
        torso_img = parts["torso"]
        tw2, th2 = torso_img.size
        canvas.paste(torso_img, (tx - tw2 // 2, ty), torso_img)

        # Compute anchor points on torso
        shoulder_x = tx - tw2 // 2 + int(_TORSO_ANCHORS["shoulder"][0] * tw2)
        shoulder_y = ty + int(_TORSO_ANCHORS["shoulder"][1] * th2)
        hip_x = tx - tw2 // 2 + int(_TORSO_ANCHORS["hip"][0] * tw2)
        hip_y = ty + int(_TORSO_ANCHORS["hip"][1] * th2)

        # Helper: render a limb chain (upper -> lower -> end) from a root anchor
        def _render_limb(upper_key, lower_key, end_key, upper_angle, lower_angle,
                         end_angle, root_anchor, flip=False):
            def _get(k):
                p = parts.get(k)
                if p is None:
                    return None
                return _IOps.mirror(p) if flip else p

            upper = _get(upper_key)
            if upper is None:
                return
            ur, upivot = _rotate_part(upper, upper_angle, _PART_PIVOTS[upper_key]["attach"])
            bx, by, bw, bh = _paste_part(canvas, ur, root_anchor, _PART_PIVOTS[upper_key]["attach"])
            # Child anchor of upper in canvas space
            child_frac = _PART_PIVOTS[upper_key]["child"]
            if child_frac is None:
                return
            upper_child = (bx + int(child_frac[0] * bw), by + int(child_frac[1] * bh))

            lower = _get(lower_key)
            if lower is None:
                return
            lr, _ = _rotate_part(lower, lower_angle, _PART_PIVOTS[lower_key]["attach"])
            bx2, by2, bw2, bh2 = _paste_part(canvas, lr, upper_child, _PART_PIVOTS[lower_key]["attach"])
            child_frac2 = _PART_PIVOTS[lower_key]["child"]
            if child_frac2 is None or end_key not in parts:
                return
            lower_child = (bx2 + int(child_frac2[0] * bw2), by2 + int(child_frac2[1] * bh2))

            end = _get(end_key)
            if end is None:
                return
            er, _ = _rotate_part(end, end_angle, _PART_PIVOTS[end_key]["attach"])
            _paste_part(canvas, er, lower_child, _PART_PIVOTS[end_key]["attach"])

        # Z-order: far leg, far arm, torso (already drawn), near leg, near arm, head, hair, hands
        # Far side (flipped, drawn first/behind)
        _render_limb("upper_leg", "lower_leg", "foot",
                     kf["far_upper_leg"], kf["far_lower_leg"], kf["far_foot"],
                     (hip_x, hip_y), flip=True)
        _render_limb("upper_arm", "lower_arm", "hand",
                     kf["far_upper_arm"], kf["far_lower_arm"], 0,
                     (shoulder_x, shoulder_y), flip=True)

        # Torso already pasted; re-paste on top of far limbs
        canvas.paste(torso_img, (tx - tw2 // 2, ty), torso_img)

        # Near side
        _render_limb("upper_leg", "lower_leg", "foot",
                     kf["near_upper_leg"], kf["near_lower_leg"], kf["near_foot"],
                     (hip_x, hip_y), flip=False)
        _render_limb("upper_arm", "lower_arm", "hand",
                     kf["near_upper_arm"], kf["near_lower_arm"], 0,
                     (shoulder_x, shoulder_y), flip=False)

        # Head
        if "head" in parts:
            head = parts["head"]
            hw, hh = head.size
            head_anchor = (tx - tw2 // 2 + int(0.5 * tw2), ty + kf["head_bob"])
            hx = head_anchor[0] - hw // 2
            hy = head_anchor[1] - hh
            canvas.paste(head, (hx, hy), head)
            # Hair on top of head
            if "hair" in parts:
                hair = parts["hair"]
                harw, harh = hair.size
                canvas.paste(hair, (hx + hw // 2 - harw // 2, hy - harh + int(0.1 * harh)), hair)

        # Crop to tight bounding box with small padding
        bbox = canvas.getbbox()
        if bbox:
            pad = 8
            bbox = (max(0, bbox[0]-pad), max(0, bbox[1]-pad),
                    min(canvas_w, bbox[2]+pad), min(canvas_h, bbox[3]+pad))
            canvas = canvas.crop(bbox)

        frames.append(canvas)

    # Normalise all frames to same height (tallest frame), pad others
    max_h = max(f.size[1] for f in frames)
    max_w = max(f.size[0] for f in frames)
    normalised = []
    for fr in frames:
        fw, fh = fr.size
        if fw < max_w or fh < max_h:
            padded = _Img.new("RGBA", (max_w, max_h), (0, 0, 0, 0))
            padded.paste(fr, ((max_w - fw) // 2, max_h - fh))
            normalised.append(padded)
        else:
            normalised.append(fr)

    # Composite onto gray background
    bg_color = (180, 180, 180)
    final_frames = []
    for fr in normalised:
        bg = _Img.new("RGB", fr.size, bg_color)
        bg.paste(fr, (0, 0), fr)
        final_frames.append(bg)

    # Build horizontal strip
    sheet_w = max_w * N_FRAMES
    sheet = _Img.new("RGB", (sheet_w, max_h), bg_color)
    for i, fr in enumerate(final_frames):
        sheet.paste(fr, (i * max_w, 0))

    buf = _io.BytesIO()
    sheet.save(buf, "JPEG", quality=90)
    image_data = buf.getvalue()

    ts = _dt.datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    filename = f"{entity_slug}_walk_{gait}_{ts}.jpg"
    role = f"walk_sheet"
    return await _save_character_asset(project, entity, project_slug, image_data, filename, role)



# ---------------------------------------------------------------------------
# Static frontend (must be last - catch-all)
# ---------------------------------------------------------------------------

from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

_FRONTEND_DIST = Path(__file__).parent.parent / "frontend" / "dist"


@app.get("/")
async def serve_index():
    response = FileResponse(str(_FRONTEND_DIST / "index.html"))
    response.headers["Cache-Control"] = "no-store"
    return response


if _FRONTEND_DIST.exists():
    app.mount("/", StaticFiles(directory=str(_FRONTEND_DIST), html=True), name="static")


# ---------------------------------------------------------------------------
# File watcher - reindex on out-of-band Markdown edits
# ---------------------------------------------------------------------------

from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler, FileModifiedEvent, FileCreatedEvent


_main_loop: asyncio.AbstractEventLoop | None = None


class _ContentWatcher(FileSystemEventHandler):
    def on_modified(self, event: FileModifiedEvent):  # type: ignore[override]
        self._handle(event.src_path)

    def on_created(self, event: FileCreatedEvent):  # type: ignore[override]
        self._handle(event.src_path)

    def _handle(self, src_path: str) -> None:
        p = Path(src_path)
        if p.suffix != ".md":
            return
        try:
            entity_slug  = p.stem
            project_slug = p.parent.parent.name
        except Exception:
            return
        if _main_loop is not None:
            _main_loop.call_soon_threadsafe(
                _main_loop.create_task,
                _reindex_entity(project_slug, entity_slug, p),
            )


async def _reindex_entity(project_slug: str, entity_slug: str, path: Path) -> None:
    """Run reindex in a thread so blocking DB ops don't stall the event loop."""
    await asyncio.to_thread(_reindex_entity_sync, project_slug, entity_slug, path)


def _reindex_entity_sync(project_slug: str, entity_slug: str, path: Path) -> None:
    try:
        post = fm.load(str(path))
        # Separate connections so _rebuild_refs doesn't deadlock inside an open write txn
        with db() as conn:
            project = conn.execute(
                "SELECT id FROM projects WHERE slug = %s", (project_slug,)
            ).fetchone()
            if not project:
                return
            project_id = project["id"]
            entity = conn.execute(
                "SELECT id FROM entities WHERE project_id = %s AND slug = %s",
                (project_id, entity_slug),
            ).fetchone()
            if entity:
                display_name = post.metadata.get("display_name", entity_slug)
                conn.execute(
                    "UPDATE entities SET display_name = %s, updated_at = NOW() WHERE id = %s",
                    (display_name, entity["id"]),
                )
                entity_id = entity["id"]
            else:
                entity_type = post.metadata.get("type", "location")
                display_name = post.metadata.get("display_name", entity_slug)
                cur = conn.execute(
                    "INSERT INTO entities (project_id, slug, type, display_name) VALUES (%s, %s, %s, %s) RETURNING id",
                    (project_id, entity_slug, entity_type, display_name),
                )
                entity_id = cur.fetchone()["id"]
        # _rebuild_refs opens its own connection - must be outside the block above
        _rebuild_refs(project_id, entity_id, post.content)
    except Exception as exc:
        log.warning("reindex_entity %s/%s: %s", project_slug, entity_slug, exc)


_observer: Observer | None = None


@app.on_event("startup")
async def start_file_watcher() -> None:
    global _observer, _main_loop
    _main_loop = asyncio.get_event_loop()
    PROJECTS_ROOT.mkdir(parents=True, exist_ok=True)
    _observer = Observer()
    _observer.schedule(_ContentWatcher(), str(PROJECTS_ROOT), recursive=True)
    _observer.start()


@app.on_event("shutdown")
def stop_file_watcher() -> None:
    if _observer:
        _observer.stop()
        _observer.join()
