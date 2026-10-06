import os
import shutil
import subprocess

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.database import get_db
from app.models import Repl, ReplCollaborator, User
from app.schemas import ForkIn, ReplCreate, ReplUpdate
from app.security import get_current_user, get_optional_user
from app.services import fsops, gitops, runtime
from app.services.repls import (
    TEMPLATES_DIR,
    author_of,
    get_template,
    list_shared,
    load_templates,
    new_repl_id,
    repl_out,
    require_role,
)

router = APIRouter(tags=["repls"])


@router.get("/templates")
async def templates():
    return load_templates()


@router.get("/repls")
async def my_repls(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    res = await db.execute(select(Repl).where(Repl.owner_id == user.id).order_by(Repl.updated_at.desc()))
    owned = [repl_out(r, "owner") for r in res.scalars().all()]
    shared = [repl_out(r, role) for r, role in await list_shared(db, user)]
    return {"owned": owned, "shared": shared}


@router.get("/explore")
async def explore(
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_optional_user),
):
    res = await db.execute(select(Repl).where(Repl.is_public.is_(True)).order_by(Repl.updated_at.desc()).limit(100))
    return [repl_out(r, "owner" if user and r.owner_id == user.id else "viewer") for r in res.scalars().all()]


async def _unique_id(db: AsyncSession) -> str:
    while True:
        rid = new_repl_id()
        if await db.get(Repl, rid) is None and not fsops.repl_root(rid).exists():
            return rid


def _create_from_template(slug: str, dest: str, message: str, author: tuple[str, str]) -> None:
    src = TEMPLATES_DIR / slug
    if src.is_dir():
        shutil.copytree(src, dest, symlinks=True, ignore=shutil.ignore_patterns(".git"))
    else:
        fsops.Path(dest).mkdir(parents=True)
    gitops.init_repo(dest, message, author)


@router.post("/repls")
async def create_repl(body: ReplCreate, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    tmpl = get_template(body.template)
    if tmpl is None or "/" in body.template or body.template.startswith("."):
        raise HTTPException(status_code=400, detail="Unknown template")
    rid = await _unique_id(db)
    dest = str(fsops.repl_root(rid))
    try:
        await run_in_threadpool(
            _create_from_template,
            body.template,
            dest,
            f"Initial commit from {tmpl.get('name', body.template)} template",
            author_of(user),
        )
    except Exception as e:
        shutil.rmtree(dest, ignore_errors=True)
        raise HTTPException(status_code=500, detail=f"Failed to create repl: {e}")
    cfg = fsops.parse_replit(fsops.repl_root(rid))
    repl = Repl(
        id=rid,
        owner_id=user.id,
        name=body.name.strip(),
        description=body.description or "",
        template=body.template,
        language=cfg.get("language") or tmpl.get("language") or "",
        is_public=body.is_public,
    )
    db.add(repl)
    await db.commit()
    repl = await db.get(Repl, rid, populate_existing=True)
    return repl_out(repl, "owner")


@router.get("/repls/{repl_id}")
async def get_repl(ctx=Depends(require_role("viewer")), db: AsyncSession = Depends(get_db)):
    repl, role, _ = ctx
    return repl_out(repl, role)


@router.patch("/repls/{repl_id}")
async def update_repl(body: ReplUpdate, ctx=Depends(require_role("owner")), db: AsyncSession = Depends(get_db)):
    repl, role, _ = ctx
    repl = await db.merge(repl)
    if body.name is not None:
        repl.name = body.name.strip()
    if body.description is not None:
        repl.description = body.description
    if body.is_public is not None:
        repl.is_public = body.is_public
    await db.commit()
    repl = await db.get(Repl, repl.id, populate_existing=True)
    return repl_out(repl, role)


@router.delete("/repls/{repl_id}", status_code=204)
async def delete_repl(ctx=Depends(require_role("owner")), db: AsyncSession = Depends(get_db)):
    repl, _, _ = ctx
    await runtime.remove(repl.id)
    await run_in_threadpool(shutil.rmtree, str(fsops.repl_root(repl.id)), True)
    obj = await db.get(Repl, repl.id)
    await db.delete(obj)
    await db.commit()
    return Response(status_code=204)


def _fork_copy(src: str, dest: str) -> None:
    # The source tree is controlled by its repl user, who can swap entries for
    # symlinks mid-copy. Copy as the unprivileged repl uid (no docker group),
    # so even a followed symlink can only reach what that uid could read.
    os.mkdir(dest, 0o755)
    os.chown(dest, fsops.RUNNER_UID, fsops.RUNNER_GID)
    subprocess.run(
        ["cp", "-a", "--no-dereference", "--", src + "/.", dest],
        user=fsops.RUNNER_UID, group=fsops.RUNNER_GID, extra_groups=[],
        env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
        check=True, capture_output=True, timeout=300,
    )
    fsops.chown_tree(dest)


@router.post("/repls/{repl_id}/fork")
async def fork_repl(
    body: ForkIn | None = None,
    ctx=Depends(require_role("viewer")),
    db: AsyncSession = Depends(get_db),
):
    src, _, user = ctx
    if user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    rid = await _unique_id(db)
    try:
        await run_in_threadpool(_fork_copy, str(fsops.repl_root(src.id)), str(fsops.repl_root(rid)))
    except Exception as e:
        shutil.rmtree(str(fsops.repl_root(rid)), ignore_errors=True)
        raise HTTPException(status_code=500, detail=f"Failed to fork: {e}")
    name = (body.name if body and body.name else None) or f"{src.name} (fork)"
    repl = Repl(
        id=rid,
        owner_id=user.id,
        name=name.strip(),
        description=src.description or "",
        template=src.template,
        language=src.language,
        is_public=False,
        forked_from=src.id,
    )
    db.add(repl)
    await db.commit()
    repl = await db.get(Repl, rid, populate_existing=True)
    return repl_out(repl, "owner")


# ---- runtime ----


@router.post("/repls/{repl_id}/start")
async def start_repl(ctx=Depends(require_role("editor"))):
    repl, _, _ = ctx
    await runtime.start(repl.id)
    return {"status": "running"}


@router.post("/repls/{repl_id}/stop")
async def stop_repl(ctx=Depends(require_role("editor"))):
    repl, _, _ = ctx
    await runtime.stop(repl.id)
    return {"status": "stopped"}


@router.get("/repls/{repl_id}/status")
async def repl_status(ctx=Depends(require_role("viewer"))):
    repl, _, _ = ctx
    return {"status": await runtime.status(repl.id)}


@router.get("/repls/{repl_id}/ports")
async def repl_ports(ctx=Depends(require_role("viewer"))):
    repl, _, _ = ctx
    return await runtime.ports(repl.id)


# ---- sharing ----


@router.get("/repls/{repl_id}/collaborators")
async def list_collaborators(ctx=Depends(require_role("viewer")), db: AsyncSession = Depends(get_db)):
    repl, _, _ = ctx
    res = await db.execute(
        select(ReplCollaborator).where(ReplCollaborator.repl_id == repl.id).order_by(ReplCollaborator.created_at)
    )
    return [
        {
            "user": {"id": c.user.id, "email": c.user.email, "username": c.user.username, "display_name": c.user.display_name},
            "role": c.role,
        }
        for c in res.scalars().all()
    ]


from app.schemas import CollaboratorIn  # noqa: E402


@router.post("/repls/{repl_id}/collaborators")
async def add_collaborator(body: CollaboratorIn, ctx=Depends(require_role("owner")), db: AsyncSession = Depends(get_db)):
    repl, _, _ = ctx
    from sqlalchemy import func

    res = await db.execute(select(User).where(func.lower(User.username) == body.username.strip().lower()))
    target = res.scalars().first()
    if target is None:
        raise HTTPException(status_code=404, detail="User not found")
    if target.id == repl.owner_id:
        raise HTTPException(status_code=400, detail="Owner is already a member")
    existing = await db.get(ReplCollaborator, (repl.id, target.id))
    if existing:
        existing.role = body.role
    else:
        db.add(ReplCollaborator(repl_id=repl.id, user_id=target.id, role=body.role))
    await db.commit()
    return {
        "user": {"id": target.id, "email": target.email, "username": target.username, "display_name": target.display_name},
        "role": body.role,
    }


@router.delete("/repls/{repl_id}/collaborators/{user_id}", status_code=204)
async def remove_collaborator(user_id: int, ctx=Depends(require_role("owner")), db: AsyncSession = Depends(get_db)):
    repl, _, _ = ctx
    existing = await db.get(ReplCollaborator, (repl.id, user_id))
    if existing is None:
        raise HTTPException(status_code=404, detail="Collaborator not found")
    await db.delete(existing)
    await db.commit()
    return Response(status_code=204)
