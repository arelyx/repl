from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile
from starlette.concurrency import run_in_threadpool

from app.schemas import CommitIn, FileCreate, FileRename, FileWrite, RestoreIn
from app.services import collab, fsops, gitops
from app.services.repls import author_of, require_role

router = APIRouter(prefix="/repls/{repl_id}", tags=["files"])

MAX_UPLOAD = 50 * 1024 * 1024


@router.get("/files")
async def list_files(ctx=Depends(require_role("viewer"))):
    repl, _, _ = ctx
    return await run_in_threadpool(fsops.list_files, repl.id)


@router.get("/files/content")
async def get_content(path: str = Query(...), ctx=Depends(require_role("viewer"))):
    repl, _, _ = ctx
    return await run_in_threadpool(fsops.read_file, repl.id, path)


@router.put("/files/content")
async def put_content(body: FileWrite, ctx=Depends(require_role("editor"))):
    repl, _, _ = ctx
    size = await run_in_threadpool(fsops.write_file, repl.id, body.path, body.content.encode("utf-8"))
    await collab.reload_repl(repl.id)
    return {"path": body.path, "size": size}


@router.post("/files", status_code=201)
async def create_file(body: FileCreate, ctx=Depends(require_role("editor"))):
    repl, _, _ = ctx
    await run_in_threadpool(fsops.create_node, repl.id, body.path, body.type)
    return {"path": body.path, "type": body.type}


@router.post("/files/rename")
async def rename_file(body: FileRename, ctx=Depends(require_role("editor"))):
    repl, _, _ = ctx
    await run_in_threadpool(fsops.rename_node, repl.id, body.from_, body.to)
    await collab.reload_repl(repl.id)
    return {"from": body.from_, "to": body.to}


@router.delete("/files", status_code=204)
async def delete_file(path: str = Query(...), ctx=Depends(require_role("editor"))):
    repl, _, _ = ctx
    await run_in_threadpool(fsops.delete_node, repl.id, path)
    await collab.reload_repl(repl.id)
    return Response(status_code=204)


@router.post("/files/upload")
async def upload_file(
    file: UploadFile = File(...),
    dir: str = Form(""),
    ctx=Depends(require_role("editor")),
):
    repl, _, _ = ctx
    name = (file.filename or "").replace("\\", "/").split("/")[-1]
    if not name or name in (".", ".."):
        raise HTTPException(status_code=400, detail="Invalid filename")
    data = await file.read()
    if len(data) > MAX_UPLOAD:
        raise HTTPException(status_code=413, detail="File too large")
    d = dir.strip().strip("/")
    rel = f"{d}/{name}" if d else name
    size = await run_in_threadpool(fsops.write_file, repl.id, rel, data)
    await collab.reload_repl(repl.id)
    return {"path": rel, "size": size}


@router.get("/download")
async def download(ctx=Depends(require_role("viewer"))):
    repl, _, _ = ctx
    data = await run_in_threadpool(fsops.zip_repl, repl.id)
    safe = "".join(c if c.isalnum() or c in "-_" else "-" for c in repl.name) or repl.id
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{safe}.zip"'},
    )


# ---- git ----


def _repo(repl_id: str) -> str:
    return str(fsops.repl_root(repl_id))


async def _git_call(fn, *args):
    try:
        return await run_in_threadpool(fn, *args)
    except gitops.GitError as e:
        raise HTTPException(status_code=400, detail=str(e) or "git error")


@router.get("/git/status")
async def git_status(ctx=Depends(require_role("viewer"))):
    repl, _, _ = ctx
    return await _git_call(gitops.status, _repo(repl.id))


@router.get("/git/log")
async def git_log(limit: int = Query(50, ge=1, le=500), ctx=Depends(require_role("viewer"))):
    repl, _, _ = ctx
    return await _git_call(gitops.log, _repo(repl.id), limit)


@router.post("/git/commit")
async def git_commit(body: CommitIn, ctx=Depends(require_role("editor"))):
    repl, _, user = ctx
    sha = await _git_call(gitops.commit, _repo(repl.id), body.message.strip(), author_of(user))
    entries = await _git_call(gitops.log, _repo(repl.id), 1)
    return entries[0] if entries else {"sha": sha}


@router.get("/git/diff")
async def git_diff(sha: str | None = Query(None), ctx=Depends(require_role("viewer"))):
    repl, _, _ = ctx
    return {"diff": await _git_call(gitops.diff, _repo(repl.id), sha or None)}


@router.get("/git/show")
async def git_show(sha: str = Query(...), path: str = Query(...), ctx=Depends(require_role("viewer"))):
    repl, _, _ = ctx
    fsops.safe_path(repl.id, path)  # validation only
    return {"content": await _git_call(gitops.show, _repo(repl.id), sha, path.strip("/"))}


@router.post("/git/restore")
async def git_restore(body: RestoreIn, ctx=Depends(require_role("editor"))):
    repl, _, user = ctx
    path = None
    if body.path:
        fsops.safe_path(repl.id, body.path)
        path = body.path.strip("/")
    sha = await _git_call(gitops.restore, _repo(repl.id), body.sha, path, author_of(user))
    await collab.reload_repl(repl.id)
    return {"sha": sha}
