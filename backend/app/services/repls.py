"""Repl access control, templates and serialization."""
import json
import secrets
import string
from functools import lru_cache
from pathlib import Path

from fastapi import Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import Repl, ReplCollaborator, User
from app.security import get_optional_user
from app.services import fsops, runtime

TEMPLATES_DIR = Path(__file__).resolve().parent.parent / "templates_data"
ROLE_RANK = {"viewer": 1, "editor": 2, "owner": 3}
ID_ALPHABET = string.ascii_lowercase + string.digits


def new_repl_id() -> str:
    return "".join(secrets.choice(ID_ALPHABET) for _ in range(10))


def load_templates() -> list[dict]:
    try:
        data = json.loads((TEMPLATES_DIR / "index.json").read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def get_template(slug: str) -> dict | None:
    for t in load_templates():
        if t.get("slug") == slug:
            return t
    return None


async def get_role(db: AsyncSession, repl: Repl, user: User | None) -> str | None:
    if user is not None:
        if repl.owner_id == user.id:
            return "owner"
        collab = await db.get(ReplCollaborator, (repl.id, user.id))
        if collab is not None:
            if collab.role == "editor" or not repl.is_public:
                return collab.role
    if repl.is_public:
        return "viewer"
    return None


async def load_repl_with_role(
    db: AsyncSession, repl_id: str, user: User | None, min_role: str
) -> tuple[Repl, str]:
    repl = await db.get(Repl, repl_id)
    role = await get_role(db, repl, user) if repl else None
    if repl is None or role is None:
        if user is None and repl is not None:
            raise HTTPException(status_code=401, detail="Not authenticated")
        raise HTTPException(status_code=404, detail="Repl not found")
    if ROLE_RANK[role] < ROLE_RANK[min_role]:
        if user is None:
            raise HTTPException(status_code=401, detail="Not authenticated")
        raise HTTPException(status_code=403, detail="Insufficient permissions")
    runtime.touch(repl.id)
    return repl, role


def require_role(min_role: str):
    async def dep(
        repl_id: str,
        db: AsyncSession = Depends(get_db),
        user: User | None = Depends(get_optional_user),
    ) -> tuple[Repl, str, User | None]:
        repl, role = await load_repl_with_role(db, repl_id, user, min_role)
        return repl, role, user

    return dep


def repl_out(repl: Repl, role: str) -> dict:
    cfg = fsops.parse_replit(fsops.repl_root(repl.id))
    return {
        "id": repl.id,
        "name": repl.name,
        "description": repl.description or "",
        "template": repl.template,
        "language": repl.language or "",
        "is_public": repl.is_public,
        "owner": {
            "id": repl.owner.id,
            "username": repl.owner.username,
            "display_name": repl.owner.display_name,
        },
        "role": role,
        "forked_from": repl.forked_from,
        "created_at": repl.created_at,
        "updated_at": repl.updated_at,
        "config": {
            "run": cfg["run"],
            "entrypoint": cfg["entrypoint"],
            "gui": cfg["gui"],
            "port": cfg["port"],
        },
    }


async def list_shared(db: AsyncSession, user: User) -> list[tuple[Repl, str]]:
    rows = await db.execute(
        select(Repl, ReplCollaborator.role)
        .join(ReplCollaborator, ReplCollaborator.repl_id == Repl.id)
        .where(ReplCollaborator.user_id == user.id)
        .order_by(Repl.updated_at.desc())
    )
    return [(r, role) for r, role in rows.all()]


def author_of(user: User) -> tuple[str, str]:
    return (user.display_name or user.username, user.email)
