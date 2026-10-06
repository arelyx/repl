"""Docker container lifecycle for repls."""
import asyncio
import logging
import time

import httpx
from fastapi import HTTPException
from starlette.concurrency import run_in_threadpool

from app.config import settings

log = logging.getLogger("replot.runtime")

_client = None
# repl_id -> monotonic time of last activity
last_active: dict[str, float] = {}


def touch(repl_id: str) -> None:
    last_active[repl_id] = time.monotonic()


def docker_client():
    global _client
    if _client is None:
        import docker

        _client = docker.from_env()
    return _client


def container_name(repl_id: str) -> str:
    return f"repl-{repl_id}"


def agent_url(repl_id: str, path: str) -> str:
    return f"http://{container_name(repl_id)}:8008{path}"


def _get(repl_id: str):
    import docker.errors

    try:
        return docker_client().containers.get(container_name(repl_id))
    except docker.errors.NotFound:
        return None


def _status(repl_id: str) -> str:
    c = _get(repl_id)
    if c is None:
        return "missing"
    return "running" if c.status == "running" else "stopped"


def _ensure_started(repl_id: str) -> None:
    c = _get(repl_id)
    if c is None:
        kwargs = dict(
            image=settings.RUNNER_IMAGE,
            name=container_name(repl_id),
            hostname=repl_id,
            detach=True,
            network=settings.REPL_NETWORK,
            volumes={f"{settings.repls_host_dir}/{repl_id}": {"bind": "/home/runner/app", "mode": "rw"}},
            mem_limit="2g",
            nano_cpus=2_000_000_000,
            pids_limit=1024,
            cap_drop=["ALL"],
            cap_add=["CHOWN", "SETUID", "SETGID", "DAC_OVERRIDE", "KILL"],
            security_opt=["no-new-privileges"],
            labels={"replot.repl": repl_id},
            environment={"REPL_ID": repl_id},
        )
        if settings.REPL_RUNTIME:
            kwargs["runtime"] = settings.REPL_RUNTIME
        docker_client().containers.run(**kwargs)
    elif c.status != "running":
        c.start()


def _stop(repl_id: str) -> None:
    c = _get(repl_id)
    if c is not None and c.status == "running":
        c.stop(timeout=5)


def _remove(repl_id: str) -> None:
    c = _get(repl_id)
    if c is not None:
        c.remove(force=True)


async def status(repl_id: str) -> str:
    try:
        return await run_in_threadpool(_status, repl_id)
    except Exception as e:  # docker unavailable
        log.warning("docker status failed: %s", e)
        return "missing"


async def start(repl_id: str) -> None:
    try:
        await run_in_threadpool(_ensure_started, repl_id)
    except Exception as e:
        log.exception("failed to start container")
        raise HTTPException(status_code=500, detail=f"Failed to start container: {e}")
    touch(repl_id)
    deadline = time.monotonic() + 30
    async with httpx.AsyncClient(timeout=2) as client:
        while time.monotonic() < deadline:
            try:
                r = await client.get(agent_url(repl_id, "/health"))
                if r.status_code == 200:
                    return
            except httpx.HTTPError:
                pass
            await asyncio.sleep(0.5)
    raise HTTPException(status_code=504, detail="Container agent did not become healthy")


async def stop(repl_id: str) -> None:
    try:
        await run_in_threadpool(_stop, repl_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to stop container: {e}")
    last_active.pop(repl_id, None)


async def remove(repl_id: str) -> None:
    try:
        await run_in_threadpool(_remove, repl_id)
    except Exception as e:
        log.warning("failed to remove container %s: %s", repl_id, e)
    last_active.pop(repl_id, None)


def preview_base(repl_id: str) -> str:
    return f"http://{repl_id}-{{port}}.preview.{settings.PUBLIC_HOST}"


async def ports(repl_id: str) -> dict:
    result = {"ports": [], "preview_base": preview_base(repl_id)}
    if await status(repl_id) != "running":
        return result
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            r = await client.get(agent_url(repl_id, "/ports"))
            if r.status_code == 200:
                result["ports"] = [int(p) for p in r.json().get("ports", [])]
    except (httpx.HTTPError, ValueError):
        pass
    return result


def _running_repl_ids() -> list[str]:
    cs = docker_client().containers.list(filters={"label": "replot.repl", "status": "running"})
    return [c.labels.get("replot.repl") for c in cs if c.labels.get("replot.repl")]


async def reap_once() -> None:
    try:
        ids = await run_in_threadpool(_running_repl_ids)
    except Exception as e:
        log.warning("reaper: docker list failed: %s", e)
        return
    now = time.monotonic()
    timeout = settings.IDLE_TIMEOUT_MINUTES * 60
    async with httpx.AsyncClient(timeout=3) as client:
        for rid in ids:
            clients = 0
            try:
                r = await client.get(agent_url(rid, "/health"))
                clients = int(r.json().get("clients", 0) or 0)
            except Exception:
                pass
            if clients > 0:
                last_active[rid] = now
                continue
            if rid not in last_active:
                # first sighting (e.g. after backend restart): start the clock now
                last_active[rid] = now
                continue
            if now - last_active[rid] > timeout:
                log.info("reaper: stopping idle repl %s", rid)
                try:
                    await run_in_threadpool(_stop, rid)
                except Exception as e:
                    log.warning("reaper: stop %s failed: %s", rid, e)
                last_active.pop(rid, None)


async def reaper_loop() -> None:
    while True:
        try:
            await reap_once()
        except Exception:
            log.exception("reaper iteration failed")
        await asyncio.sleep(60)
