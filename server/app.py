from __future__ import annotations

import logging
import os

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("terrrence")
import secrets
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from fastapi import Cookie, FastAPI, HTTPException, Response
from pydantic import BaseModel

DB_PATH     = Path(os.environ.get("TERRRENCE_DB",     "/workspace/data/terrrence.db"))
COOKIE_NAME = "terrrence_session"

def _load_secret(key: str) -> str | None:
    """Read a secret from /workspace/.secrets file, falling back to env var."""
    secrets_path = Path("/workspace/.secrets")
    if secrets_path.exists():
        for line in secrets_path.read_text().splitlines():
            line = line.strip()
            if line.startswith(key + "="):
                return line[len(key) + 1:].strip()
    return os.environ.get(key)
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
    conn.execute("PRAGMA busy_timeout = 5000")
    try:
        yield conn
        conn.commit()
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

ENTITY_TYPES = {"location", "character", "item", "event", "game", "chapter", "conversation"}
REF_PATTERNS = [
    (re.compile(r'@@([^@]+)@@'),             "location"),
    (re.compile(r'##([^#]+)##'),             "character"),
    (re.compile(r'~~([^~]+)~~'),             "item"),
    (re.compile(r'!!([^!]+)!!([^!]+)!!'),    "event"),
    (re.compile(r'\?\?([^?]+)\?\?'),           "chapter"),
    (re.compile(r'\u201c\u201c([^\u201c\u201d]+)\u201d\u201d'), "conversation"),
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
    for pattern, ref_type in [REF_PATTERNS[0], REF_PATTERNS[1], REF_PATTERNS[2], REF_PATTERNS[4], REF_PATTERNS[5]]:
        for m in pattern.finditer(body_text):
            display = m.group(1).strip()
            slug = _derive_slug(display, ref_type)
            refs.append((slug, ref_type, display))
    event_pat = REF_PATTERNS[3][0]
    for m in event_pat.finditer(body_text):
        for part in (m.group(1), m.group(2)):
            for inner_pat, inner_type in [REF_PATTERNS[0], REF_PATTERNS[1], REF_PATTERNS[2], REF_PATTERNS[4], REF_PATTERNS[5]]:
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
                # Auto-stub: skip events/conversations (require parent context) and game
                if ref_type in ("event", "conversation", "game"):
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
    # chapters must be parented to game; conversations must be parented to a character
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
                return {"slug": None, "type": "event", "display_name": display_name, "created": False, "blocked": True}
            parent_row = conn.execute(
                "SELECT id FROM entities WHERE project_id = ? AND slug = ? AND type = 'chapter'",
                (project["id"], body.parent_slug),
            ).fetchone()
            if not parent_row:
                return {"slug": None, "type": "event", "display_name": display_name, "created": False, "blocked": True}
            parent_id = parent_row["id"]
        elif body.type == "conversation":
            if not body.parent_slug:
                return {"slug": None, "type": "conversation", "display_name": display_name, "created": False, "blocked": True}
            parent_row = conn.execute(
                "SELECT id FROM entities WHERE project_id = ? AND slug = ? AND type = 'character'",
                (project["id"], body.parent_slug),
            ).fetchone()
            if not parent_row:
                return {"slug": None, "type": "conversation", "display_name": display_name, "created": False, "blocked": True}
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

    # Merge incoming meta with existing, stripping reserved keys
    reserved = {"slug", "type", "display_name"}
    existing_meta = {k: v for k, v in post.metadata.items() if k not in reserved}
    if body.meta is not None:
        new_meta = {k: v for k, v in body.meta.items() if k not in reserved}
        existing_meta.update(new_meta)
    else:
        new_meta = existing_meta

    _write_entity_file(project_slug, entity_slug, new_display_name, entity["type"], new_body, extra_meta=existing_meta)

    with db() as conn:
        conn.execute(
            "UPDATE entities SET display_name = ? WHERE id = ?",
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
# Image generation
# ---------------------------------------------------------------------------

_IMAGE_TYPES = {"location", "character", "item"}

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
            "SELECT id, type, display_name FROM entities WHERE project_id = ? AND slug = ?",
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

    import re as _re

    display_name = entity["display_name"]
    entity_type  = entity["type"]

    # Strip token syntax from body text
    if body_text:
        clean_body = _re.sub(r'@@([^@]+)@@|##([^#]+)##|~~([^~]+)~~|\?\?([^?]+)\?\?', lambda m: next(g for g in m.groups() if g is not None), body_text)
        clean_body = _re.sub(r'\s+', ' ', clean_body).strip()
    else:
        clean_body = ""

    # Fetch project-level art style
    art_style = ""
    try:
        for gf in (PROJECTS_ROOT / project_slug / "content").glob("*.md"):
            gpost = fm.load(str(gf))
            if gpost.metadata.get("type") == "game":
                art_style = gpost.metadata.get("art_style", "").strip()
                break
    except Exception:
        pass

    _PROMPT_TEMPLATES: dict[str, str] = {
        "character": (
            "Full body character concept art, {description}, "
            "standing in a neutral A-pose or relaxed straight pose, "
            "entire body visible from head to toe with feet fully in frame, "
            "no cropping, clean isolated view, "
            "plain neutral light gray seamless background, "
            "studio lighting, soft even illumination, no shadows, "
            "no environment, no unrelated props or background elements, "
            "no text, no logos, no watermarks, "
            "highly detailed, clean lines, "
            "professional character design sheet style"
            "{art_style_clause}."
        ),
        "item": (
            "Full view game item sprite of {description}, "
            "centered, entire object clearly visible, "
            "isolated on plain light gray background, "
            "soft even illumination, minimal soft shadow, "
            "clean sharp details, no cropping, no background elements, "
            "no text, no logos, "
            "professional 2D inventory icon / sprite sheet style, "
            "crisp edges, high resolution game asset"
            "{art_style_clause}."
        ),
        "location": (
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
            "no text, no logos"
            "{art_style_clause}."
        ),
    }

    description = clean_body if clean_body else display_name
    art_style_clause = f", {art_style}" if art_style else ""
    prompt = _PROMPT_TEMPLATES[entity_type].format(
        description=description,
        art_style_clause=art_style_clause,
    )

    log.info("Generating image for %s/%s: %s", project_slug, entity_slug, prompt[:80])

    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(
            "https://api.x.ai/v1/images/generations",
            headers={"Authorization": f"Bearer {xai_key}", "Content-Type": "application/json"},
            json={"model": "grok-imagine-image", "prompt": prompt, "n": 1},
        )
    if resp.status_code != 200:
        log.error("xAI image generation failed: %s %s", resp.status_code, resp.text)
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
            "INSERT INTO assets (project_id, rel_path, mime, bytes, sha256) VALUES (?, ?, ?, ?, ?)",
            (project["id"], rel_path, mime, len(image_data), sha256),
        )
        asset_id = cur.lastrowid
        conn.execute(
            "INSERT INTO asset_entities (asset_id, entity_id, role) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
            (asset_id, entity["id"], "generated"),
        )

    log.info("Image generated and saved: %s (asset %d)", filename, asset_id)
    return {"id": asset_id, "rel_path": rel_path, "mime": mime, "bytes": len(image_data), "sha256": sha256}


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
                entity_id = entity["id"]
            else:
                entity_type = post.metadata.get("type", "location")
                display_name = post.metadata.get("display_name", entity_slug)
                cur = conn.execute(
                    "INSERT INTO entities (project_id, slug, type, display_name) VALUES (?, ?, ?, ?)",
                    (project_id, entity_slug, entity_type, display_name),
                )
                entity_id = cur.lastrowid
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
