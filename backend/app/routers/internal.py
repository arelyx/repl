import hmac

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.config import settings
from app.database import get_db
from app.models import Repl, User
from app.schemas import InternalFileWrite
from app.security import get_optional_user
from app.services import fsops, runtime
from app.services.repls import ROLE_RANK, get_role

router = APIRouter(prefix="/internal", tags=["internal"])

# lsp needs editor: language servers run project code (build scripts,
# Maven/Gradle imports), so they are as powerful as a shell.
SERVICE_MIN_ROLE = {"run": "viewer", "shell": "editor", "vnc": "editor", "lsp": "editor"}


@router.get("/auth-repl")
async def auth_repl(
    x_repl_id: str = Header(""),
    x_repl_service: str = Header(""),
    user: User | None = Depends(get_optional_user),
    db: AsyncSession = Depends(get_db),
):
    min_role = SERVICE_MIN_ROLE.get(x_repl_service)
    if min_role is None or not x_repl_id:
        return Response(status_code=403)
    repl = await db.get(Repl, x_repl_id)
    if repl is None:
        return Response(status_code=403 if user else 401)
    role = await get_role(db, repl, user)
    if role is None or ROLE_RANK[role] < ROLE_RANK[min_role]:
        return Response(status_code=401 if user is None else 403)
    if ROLE_RANK[role] >= ROLE_RANK["editor"]:
        runtime.touch_editor(repl.id)
    # nginx forwards both to the agent: the role (viewers can't control Run)
    # and the repl's agent token, which the agent requires on every request.
    return Response(status_code=204, headers={
        "X-Repl-Role": role, "X-Agent-Token": runtime.agent_token(repl.id)})


@router.get("/collab-auth")
async def collab_auth(
    repl_id: str = Query(...),
    path: str = Query(""),
    user: User | None = Depends(get_optional_user),
    db: AsyncSession = Depends(get_db),
):
    if user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    repl = await db.get(Repl, repl_id)
    role = await get_role(db, repl, user) if repl else None
    if role is None:
        raise HTTPException(status_code=403, detail="Forbidden")
    if path:
        fsops.safe_path(repl_id, path)
    if ROLE_RANK[role] >= ROLE_RANK["editor"]:
        runtime.touch_editor(repl_id)
    return {
        "user_id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "read_only": ROLE_RANK[role] < ROLE_RANK["editor"],
    }


def _check_secret(secret: str) -> None:
    if not hmac.compare_digest(secret or "", settings.INTERNAL_SECRET):
        raise HTTPException(status_code=403, detail="Forbidden")


@router.get("/files/content")
async def internal_get(
    repl_id: str = Query(...),
    path: str = Query(...),
    x_internal_secret: str = Header(""),
    db: AsyncSession = Depends(get_db),
):
    _check_secret(x_internal_secret)
    if await db.get(Repl, repl_id) is None:
        raise HTTPException(status_code=404, detail="Repl not found")
    return {"content": await run_in_threadpool(fsops.read_text, repl_id, path)}


@router.put("/files/content")
async def internal_put(
    body: InternalFileWrite,
    x_internal_secret: str = Header(""),
    db: AsyncSession = Depends(get_db),
):
    _check_secret(x_internal_secret)
    if await db.get(Repl, body.repl_id) is None:
        raise HTTPException(status_code=404, detail="Repl not found")
    size = await run_in_threadpool(fsops.write_file, body.repl_id, body.path, body.content.encode("utf-8"))
    return {"path": body.path, "size": size}
