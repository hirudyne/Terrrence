from __future__ import annotations

import os
import secrets
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from fastapi import Cookie, FastAPI, HTTPException, Response
from pydantic import BaseModel

DB_PATH     = Path(os.environ.get("TERRRENCE_DB",     "/workspace/data/terrrence.db"))
YJS_DB_PATH = Path(os.environ.get("TERRRENCE_YJS_DB", "/workspace/data/terrrence_yjs.db"))
COOKIE_NAME = "terrrence_session"
INSECURE    = os.environ.get("TERRRENCE_INSECURE_COOKIES", "0") == "1"

ph  = PasswordHasher()
app = FastAPI(title="Terrrence", version="0.0.1")


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


@contextmanager
def yjs_db():
    conn = sqlite3.connect(YJS_DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------




def _wipe_yjs_store() -> None:
    """Clear all Yjs update rows so rooms start fresh from Markdown on disk.
    Since the HTTP debounce is the reliable save path and Markdown is the
    source of truth, stale Yjs state only causes content clobbering.
    """
    try:
        yjs_conn = sqlite3.connect(YJS_STORE_PATH, timeout=5)
        yjs_conn.execute("DELETE FROM yupdates")
        yjs_conn.commit()
        yjs_conn.close()
    except Exception:
        pass


def _cleanup_yjs_orphans():
    with db() as conn:
        live_ids = {r[0] for r in conn.execute("SELECT id FROM entities").fetchall()}
    with yjs_db() as conn:
        rows = conn.execute("SELECT entity_id FROM yjs_state").fetchall()
        for row in rows:
            if row["entity_id"] not in live_ids:
                conn.execute("DELETE FROM yjs_state WHERE entity_id = ?", (row["entity_id"],))


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
            WHERE s.session_id = ?
            """,
            (session_id,),
        ).fetchone()
        if not row:
            return None
        conn.execute(
            "UPDATE sessions SET last_seen_at = datetime('now') WHERE session_id = ?",
            (session_id,),
        )
        conn.execute(
            "UPDATE api_keys SET last_seen_at = datetime('now') WHERE id = ?",
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
            "INSERT INTO sessions (session_id, api_key_id) VALUES (?, ?)",
            (session_id, matched_id),
        )

    _set_session_cookie(response, session_id)
    return {"ok": True}


@app.post("/logout")
def logout(response: Response, session: str | None = Cookie(default=None, alias=COOKIE_NAME)):
    if session:
        with db() as conn:
            conn.execute("DELETE FROM sessions WHERE session_id = ?", (session,))
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
            "SELECT id FROM entities WHERE project_id = ? AND type = 'game'",
            (project_id,),
        ).fetchone()
        if existing:
            return
        conn.execute(
            "INSERT INTO entities (project_id, slug, type, display_name) VALUES (?, ?, 'game', ?)",
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
        existing = conn.execute("SELECT id FROM projects WHERE slug = ?", (body.slug,)).fetchone()
        if existing:
            raise HTTPException(status_code=409, detail="slug taken")
        conn.execute(
            "INSERT INTO projects (slug, display_name, owner_key_id) VALUES (?, ?, ?)",
            (body.slug, body.display_name.strip(), api_key_id),
        )
    with db() as conn:
        project_row = conn.execute("SELECT id FROM projects WHERE slug = ?", (body.slug,)).fetchone()
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
            WHERE p.owner_key_id = ?
            UNION
            SELECT p.slug, p.display_name, p.owner_key_id
            FROM projects p
            JOIN project_shares ps ON ps.project_id = p.id
            WHERE ps.api_key_id = ?
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
            "SELECT id, owner_key_id FROM projects WHERE slug = ?", (slug,)
        ).fetchone()
        if not project:
            raise HTTPException(status_code=404, detail="project not found")
        if project["owner_key_id"] != api_key_id:
            raise HTTPException(status_code=403, detail="not owner")
        target = conn.execute(
            "SELECT id FROM api_keys WHERE label = ?", (body.api_key_label,)
        ).fetchone()
        if not target:
            raise HTTPException(status_code=404, detail="target key not found")
        existing = conn.execute(
            "SELECT 1 FROM project_shares WHERE project_id = ? AND api_key_id = ?",
            (project["id"], target["id"]),
        ).fetchone()
        if not existing:
            conn.execute(
                "INSERT INTO project_shares (project_id, api_key_id) VALUES (?, ?)",
                (project["id"], target["id"]),
            )
    return {"ok": True}


# ---------------------------------------------------------------------------
# Routes - entities
# ---------------------------------------------------------------------------

import frontmatter as fm

ENTITY_TYPES = {"location", "character", "item", "event", "game", "chapter"}
REF_PATTERNS = [
    (re.compile(r'@@([^@]+)@@'),             "location"),
    (re.compile(r'##([^#]+)##'),             "character"),
    (re.compile(r'~~([^~]+)~~'),             "item"),
    (re.compile(r'!!([^!]+)!!([^!]+)!!'),    "event"),
    (re.compile(r'\?\?([^?]+)\?\?'),           "chapter"),
]


def _project_for_session(slug: str, api_key_id: int):
    with db() as conn:
        row = conn.execute(
            """
            SELECT p.id, p.owner_key_id FROM projects p
            WHERE p.slug = ?
            AND (
                p.owner_key_id = ?
                OR EXISTS (
                    SELECT 1 FROM project_shares ps
                    WHERE ps.project_id = p.id AND ps.api_key_id = ?
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
    for pattern, ref_type in [REF_PATTERNS[0], REF_PATTERNS[1], REF_PATTERNS[2], REF_PATTERNS[4]]:
        for m in pattern.finditer(body_text):
            display = m.group(1).strip()
            slug = _derive_slug(display, ref_type)
            refs.append((slug, ref_type, display))
    event_pat = REF_PATTERNS[3][0]
    for m in event_pat.finditer(body_text):
        for part in (m.group(1), m.group(2)):
            for inner_pat, inner_type in [REF_PATTERNS[0], REF_PATTERNS[1], REF_PATTERNS[2], REF_PATTERNS[4]]:
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
        conn.execute("DELETE FROM entity_refs WHERE src_entity_id = ?", (entity_id,))
        counts: dict[tuple, int] = {}
        for slug, ref_type, display_name_ref in refs:
            target = conn.execute(
                "SELECT id FROM entities WHERE project_id = ? AND slug = ?",
                (project_id, slug),
            ).fetchone()
            if not target and project_slug:
                # Auto-stub: skip events (require chapter context) and game type
                if ref_type in ("event", "game"):
                    continue
                # For chapters we need a game entity parent
                parent_id = None
                if ref_type == "chapter":
                    game_row = conn.execute(
                        "SELECT id FROM entities WHERE project_id = ? AND type = 'game'",
                        (project_id,),
                    ).fetchone()
                    if game_row:
                        parent_id = game_row["id"]
                    else:
                        continue
                cur = conn.execute(
                    "INSERT INTO entities (project_id, slug, type, display_name, parent_id) VALUES (?,?,?,?,?)",
                    (project_id, slug, ref_type, display_name_ref, parent_id),
                )
                stub_id = cur.lastrowid
                target = conn.execute("SELECT id FROM entities WHERE id=?", (stub_id,)).fetchone()
                new_stubs.append(slug)
                _write_entity_file(project_slug, slug, display_name_ref, ref_type, "")
            if target:
                key = (entity_id, target["id"])
                counts[key] = counts.get(key, 0) + 1
        for (src, tgt), cnt in counts.items():
            conn.execute(
                """
                INSERT INTO entity_refs (src_entity_id, dst_entity_id, occurrences)
                VALUES (?, ?, ?)
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
                "SELECT id FROM entities WHERE project_id = ? AND type = 'game'",
                (project["id"],),
            ).fetchone()
            if existing_game:
                raise HTTPException(status_code=409, detail="project already has a game entity")
    # chapters must be parented to the game entity
    parent_id: int | None = None
    if body.type == "chapter":
        with db() as conn:
            game_row = conn.execute(
                "SELECT id FROM entities WHERE project_id = ? AND type = 'game'",
                (project["id"],),
            ).fetchone()
            if not game_row:
                raise HTTPException(status_code=409, detail="create the game entity first")
            parent_id = game_row["id"]
    elif body.parent_slug:
        with db() as conn:
            parent_row = conn.execute(
                "SELECT id FROM entities WHERE project_id = ? AND slug = ?",
                (project["id"], body.parent_slug),
            ).fetchone()
            if not parent_row:
                raise HTTPException(status_code=404, detail="parent entity not found")
            parent_id = parent_row["id"]
    with db() as conn:
        existing = conn.execute(
            "SELECT id FROM entities WHERE project_id = ? AND slug = ?",
            (project["id"], body.slug),
        ).fetchone()
        if existing:
            raise HTTPException(status_code=409, detail="slug taken")
        cur = conn.execute(
            "INSERT INTO entities (project_id, slug, type, display_name, parent_id) VALUES (?, ?, ?, ?, ?)",
            (project["id"], body.slug, body.type, body.display_name.strip(), parent_id),
        )
        entity_id = cur.lastrowid
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
            "SELECT id, type FROM entities WHERE project_id = ? AND slug = ?",
            (project["id"], entity_slug),
        ).fetchone()
        if not entity:
            raise HTTPException(status_code=404, detail="entity not found")
        if entity["type"] == "game":
            raise HTTPException(status_code=403, detail="the game entity cannot be deleted")
        conn.execute("DELETE FROM entities WHERE id = ?", (entity["id"],))
    entity_path = _entity_path(project_slug, entity_slug)
    if entity_path.exists():
        entity_path.unlink()


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
                          p.slug AS parent_slug
                   FROM entities e
                   LEFT JOIN entities p ON p.id = e.parent_id
                   WHERE e.project_id = ? AND e.type = ?""",
                (project["id"], type),
            ).fetchall()
        else:
            rows = conn.execute(
                """SELECT e.slug, e.type, e.display_name,
                          p.slug AS parent_slug
                   FROM entities e
                   LEFT JOIN entities p ON p.id = e.parent_id
                   WHERE e.project_id = ?""",
                (project["id"],),
            ).fetchall()
    return [{"slug": r["slug"], "type": r["type"], "display_name": r["display_name"], "parent_slug": r["parent_slug"]} for r in rows]


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
            "SELECT slug, type, display_name, parent_id FROM entities WHERE project_id = ? AND slug = ?",
            (project["id"], slug),
        ).fetchone()
        if existing:
            return {"slug": existing["slug"], "type": existing["type"],
                    "display_name": existing["display_name"], "created": False}
        parent_id = None
        if body.type == "chapter":
            game_row = conn.execute(
                "SELECT id FROM entities WHERE project_id = ? AND type = 'game'",
                (project["id"],),
            ).fetchone()
            if game_row:
                parent_id = game_row["id"]
        elif body.type == "event":
            if not body.parent_slug:
                # No chapter context - refuse to create, return sentinel
                return {"slug": None, "type": "event", "display_name": display_name, "created": False, "blocked": True}
            parent_row = conn.execute(
                "SELECT id FROM entities WHERE project_id = ? AND slug = ? AND type = 'chapter'",
                (project["id"], body.parent_slug),
            ).fetchone()
            if not parent_row:
                return {"slug": None, "type": "event", "display_name": display_name, "created": False, "blocked": True}
            parent_id = parent_row["id"]
        elif body.parent_slug:
            parent_row = conn.execute(
                "SELECT id FROM entities WHERE project_id = ? AND slug = ?",
                (project["id"], body.parent_slug),
            ).fetchone()
            if parent_row:
                parent_id = parent_row["id"]
        cur = conn.execute(
            "INSERT INTO entities (project_id, slug, type, display_name, parent_id) VALUES (?, ?, ?, ?, ?)",
            (project["id"], slug, body.type, display_name, parent_id),
        )
        entity_id = cur.lastrowid
    _write_entity_file(project_slug, slug, display_name, body.type, "")
    return {"slug": slug, "type": body.type, "display_name": display_name, "created": True}


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
            "SELECT id, type, display_name FROM entities WHERE project_id = ? AND slug = ?",
            (project["id"], entity_slug),
        ).fetchone()
        if not entity:
            raise HTTPException(status_code=404, detail="entity not found")

    post = _read_entity_file(project_slug, entity_slug)
    new_display_name = body.display_name.strip() if body.display_name is not None else entity["display_name"]
    new_body         = body.body if body.body is not None else post.content

    _write_entity_file(project_slug, entity_slug, new_display_name, entity["type"], new_body)

    with db() as conn:
        conn.execute(
            "UPDATE entities SET display_name = ? WHERE id = ?",
            (new_display_name, entity["id"]),
        )
    _rebuild_refs(project["id"], entity["id"], new_body,
                  entity_type=entity["type"], project_slug=project_slug)
    return {"slug": entity_slug, "display_name": new_display_name, "type": entity["type"]}


# ---------------------------------------------------------------------------
# Yjs WebSocket endpoint
# ---------------------------------------------------------------------------

import asyncio
import y_py as Y_py
from fastapi import WebSocket, WebSocketDisconnect
from ypy_websocket import WebsocketServer, YRoom
from ypy_websocket.ystore import SQLiteYStore

YJS_STORE_PATH = str(Path(os.environ.get("TERRRENCE_YJS_STORE", "/workspace/data/terrrence_yjs_updates.db")))


class _TerrrenceYStore(SQLiteYStore):
    db_path = YJS_STORE_PATH


async def _flush_room_to_markdown(room_name: str) -> None:
    """Serialize the Yjs doc for a room to its Markdown file on disk."""
    try:
        parts = room_name.split("/", 1)
        if len(parts) != 2:
            return
        project_slug, entity_slug = parts
        entity_path = PROJECTS_ROOT / project_slug / "content" / f"{entity_slug}.md"
        if not entity_path.exists():
            return

        post = fm.load(str(entity_path))

        # Read all updates from the store and apply them to a fresh doc
        store = _TerrrenceYStore(room_name)
        ydoc = Y_py.YDoc()
        async with store:
            async for update, _meta, _ts in store.read():
                Y_py.apply_update(ydoc, update)

        text = str(ydoc.get_text("codemirror"))
        if text:
            post.content = text
            entity_path.write_text(fm.dumps(post), encoding="utf-8")

            # Update display_name in DB if frontmatter changed
            with db() as conn:
                conn.execute(
                    "UPDATE entities SET display_name = ?, updated_at = datetime('now') WHERE slug = ? AND project_id = (SELECT id FROM projects WHERE slug = ?)",
                    (post.metadata.get("display_name", entity_slug), entity_slug, project_slug),
                )
    except Exception as exc:
        import logging
        logging.getLogger("terrrence").warning("flush_room_to_markdown %s: %s", room_name, exc)


class _TerrrenceYServer(WebsocketServer):
    async def get_room(self, name: str) -> YRoom:
        if name not in self.rooms:
            store = _TerrrenceYStore(name)
            self.rooms[name] = YRoom(ready=self.rooms_ready, ystore=store, log=self.log)
        room = self.rooms[name]
        await self.start_room(room)
        return room

    def delete_room(self, *, room: YRoom | None = None, name: str | None = None) -> None:  # type: ignore[override]
        # Flush to Markdown before deleting
        if room is not None:
            room_name = next((k for k, v in self.rooms.items() if v is room), None)
        else:
            room_name = name
        if room_name and _main_loop is not None:
            _main_loop.call_soon_threadsafe(
                _main_loop.create_task,
                _flush_room_to_markdown(room_name),
            )
        super().delete_room(room=room)


_yjs_server = _TerrrenceYServer()
_yjs_server_task: asyncio.Task | None = None


@app.on_event("startup")
async def startup():
    _wipe_yjs_store()
    _cleanup_yjs_orphans()
    _prune_sessions()

    global _yjs_server_task

    async def _run():
        async with _yjs_server:
            await asyncio.get_event_loop().create_future()  # run forever

    _yjs_server_task = asyncio.create_task(_run())


def _prune_sessions() -> None:
    """Delete sessions not seen in the last 30 days."""
    with db() as conn:
        conn.execute(
            "DELETE FROM sessions WHERE last_seen_at < datetime('now', '-30 days')"
        )


from ypy_websocket import ASGIServer
from ypy_websocket.asgi_server import ASGIWebsocket
from starlette.websockets import WebSocketState


def _yjs_on_connect(msg: dict, scope: dict) -> bool:
    """Return True to reject the connection."""
    # Extract session cookie from scope headers
    headers = dict(scope.get("headers", []))
    cookie_header = headers.get(b"cookie", b"").decode("utf-8", errors="ignore")
    session_id = None
    for part in cookie_header.split(";"):
        part = part.strip()
        if part.startswith(COOKIE_NAME + "="):
            session_id = part[len(COOKIE_NAME) + 1:]
            break
    if not session_id:
        return True  # reject
    resolved = _resolve_session(session_id)
    return resolved is None  # reject if unresolved


_yjs_asgi = ASGIServer(_yjs_server, on_connect=_yjs_on_connect)


@app.websocket("/ws/yjs/{project_slug}/{entity_slug}")
async def yjs_ws(
    websocket: WebSocket,
    project_slug: str,
    entity_slug: str,
):
    # Delegate to the ASGI server directly via the raw ASGI interface.
    # This gives ypy-websocket its own ASGIWebsocket with correct path and
    # disconnect handling, instead of our hand-rolled adapter.
    scope = websocket.scope
    scope["path"] = f"/{project_slug}/{entity_slug}"
    await _yjs_asgi(scope, websocket._receive, websocket._send)


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
            "SELECT id, name FROM tags WHERE project_id = ? ORDER BY name",
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
            "SELECT id FROM entities WHERE project_id = ? AND slug = ?",
            (project["id"], entity_slug),
        ).fetchone()
        if not entity:
            raise HTTPException(status_code=404, detail="entity not found")
        rows = conn.execute(
            """SELECT t.id, t.name FROM tags t
               JOIN entity_tags et ON et.tag_id = t.id
               WHERE et.entity_id = ? ORDER BY t.name""",
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
            "SELECT id FROM entities WHERE project_id = ? AND slug = ?",
            (project["id"], entity_slug),
        ).fetchone()
        if not entity:
            raise HTTPException(status_code=404, detail="entity not found")
        # upsert tag
        conn.execute(
            "INSERT OR IGNORE INTO tags (project_id, name) VALUES (?, ?)",
            (project["id"], name),
        )
        tag = conn.execute(
            "SELECT id FROM tags WHERE project_id = ? AND name = ?",
            (project["id"], name),
        ).fetchone()
        conn.execute(
            "INSERT OR IGNORE INTO entity_tags (entity_id, tag_id) VALUES (?, ?)",
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
            "SELECT id FROM entities WHERE project_id = ? AND slug = ?",
            (project["id"], entity_slug),
        ).fetchone()
        if not entity:
            raise HTTPException(status_code=404, detail="entity not found")
        tag = conn.execute(
            "SELECT id FROM tags WHERE project_id = ? AND name = ?",
            (project["id"], tag_name.strip().lower()),
        ).fetchone()
        if tag:
            conn.execute(
                "DELETE FROM entity_tags WHERE entity_id = ? AND tag_id = ?",
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
            "SELECT id FROM assets WHERE project_id = ? AND rel_path = ?",
            (project["id"], rel_path),
        ).fetchone()
        if existing:
            conn.execute(
                "UPDATE assets SET sha256 = ?, bytes = ?, mime = ? WHERE id = ?",
                (sha256, len(data), mime, existing["id"]),
            )
            asset_id = existing["id"]
        else:
            cur = conn.execute(
                "INSERT INTO assets (project_id, rel_path, mime, bytes, sha256) VALUES (?, ?, ?, ?, ?)",
                (project["id"], rel_path, mime, len(data), sha256),
            )
            asset_id = cur.lastrowid

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
            "SELECT id, rel_path, mime, bytes FROM assets WHERE project_id = ?",
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
            "SELECT rel_path, mime FROM assets WHERE id = ? AND project_id = ?",
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
            "SELECT id FROM entities WHERE project_id = ? AND slug = ?",
            (project["id"], entity_slug),
        ).fetchone()
        if not entity:
            raise HTTPException(status_code=404, detail="entity not found")
        rows = conn.execute(
            """SELECT a.id, a.rel_path, a.mime, a.bytes, ae.role
               FROM assets a JOIN asset_entities ae ON ae.asset_id = a.id
               WHERE ae.entity_id = ?""",
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
            "SELECT id FROM entities WHERE project_id = ? AND slug = ?",
            (project["id"], entity_slug),
        ).fetchone()
        if not entity:
            raise HTTPException(status_code=404, detail="entity not found")
        asset = conn.execute(
            "SELECT id FROM assets WHERE id = ? AND project_id = ?",
            (body.asset_id, project["id"]),
        ).fetchone()
        if not asset:
            raise HTTPException(status_code=404, detail="asset not found")
        conn.execute(
            """INSERT INTO asset_entities (asset_id, entity_id, role) VALUES (?, ?, ?)
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
            "SELECT id FROM entities WHERE project_id = ? AND slug = ?",
            (project["id"], entity_slug),
        ).fetchone()
        if not entity:
            raise HTTPException(status_code=404, detail="entity not found")
        conn.execute(
            "DELETE FROM asset_entities WHERE asset_id = ? AND entity_id = ?",
            (asset_id, entity["id"]),
        )


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
    try:
        post = fm.load(str(path))
        with db() as conn:
            project = conn.execute(
                "SELECT id FROM projects WHERE slug = ?", (project_slug,)
            ).fetchone()
            if not project:
                return
            project_id = project["id"]
            entity = conn.execute(
                "SELECT id FROM entities WHERE project_id = ? AND slug = ?",
                (project_id, entity_slug),
            ).fetchone()
            if entity:
                display_name = post.metadata.get("display_name", entity_slug)
                conn.execute(
                    "UPDATE entities SET display_name = ?, updated_at = datetime('now') WHERE id = ?",
                    (display_name, entity["id"]),
                )
                _rebuild_refs(project_id, entity["id"], post.content)
            else:
                entity_type = post.metadata.get("type", "location")
                display_name = post.metadata.get("display_name", entity_slug)
                cur = conn.execute(
                    "INSERT INTO entities (project_id, slug, type, display_name) VALUES (?, ?, ?, ?)",
                    (project_id, entity_slug, entity_type, display_name),
                )
                _rebuild_refs(project_id, cur.lastrowid, post.content)
    except Exception as exc:
        import logging
        logging.getLogger("terrrence").warning("reindex_entity %s/%s: %s", project_slug, entity_slug, exc)


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
