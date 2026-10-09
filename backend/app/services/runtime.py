"""Docker container lifecycle for repls."""
import asyncio
import hashlib
import hmac
import logging
import os
import subprocess
import threading
import time
from datetime import datetime, timezone

import httpx
from fastapi import HTTPException
from starlette.concurrency import run_in_threadpool

from app.config import settings

log = logging.getLogger("replot.runtime")

_client = None
# Start/stop for one repl must not interleave (the editor, the page and a
# second tab can all call start at once); one lock per repl id.
_repl_locks: dict[str, threading.Lock] = {}
_repl_locks_guard = threading.Lock()
# Held while counting running containers and creating one, so concurrent
# starts can't both slip under the per-user or global cap.
_caps_lock = threading.Lock()
# Set once Docker has rejected REPL_CGROUP_PARENT (e.g. cgroupfs driver).
_cgroup_parent_broken = False


def _lock_for(repl_id: str) -> threading.Lock:
    with _repl_locks_guard:
        return _repl_locks.setdefault(repl_id, threading.Lock())


# repl_id -> monotonic time of the last *editor* activity. Viewers (anyone can
# watch a public repl's console) don't keep a container alive.
last_active: dict[str, float] = {}


def touch(repl_id: str) -> None:
    """Any authorised request. Not activity for the reaper: viewers call this too."""


def touch_editor(repl_id: str) -> None:
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


def agent_token(repl_id: str) -> str:
    """The token the repl's agent requires on every request. Derived, so it
    needs no storage and changes when INTERNAL_SECRET is rotated."""
    return hmac.new(settings.INTERNAL_SECRET.encode(), b"agent:" + repl_id.encode(), hashlib.sha256).hexdigest()


def agent_headers(repl_id: str) -> dict[str, str]:
    return {"X-Agent-Token": agent_token(repl_id)}


def _get(repl_id: str):
    import docker.errors

    try:
        return docker_client().containers.get(container_name(repl_id))
    except docker.errors.NotFound:
        return None


def network_name(repl_id: str) -> str:
    return f"rc-repl-{repl_id}"


def _ensure_network(repl_id: str):
    """Each repl gets its own bridge network that only it, nginx, and the
    backend join, so no repl can reach another repl's agent."""
    import docker.errors

    client = docker_client()
    name = network_name(repl_id)
    try:
        net = client.networks.get(name)
    except docker.errors.NotFound:
        net = _create_network(name, repl_id)
    for gw in settings.GATEWAY_CONTAINERS.split(","):
        gw = gw.strip()
        if not gw:
            continue
        try:
            net.connect(gw)
        except docker.errors.APIError as e:
            # Already connected is the common case; anything else is logged.
            if "already exists" not in str(e):
                log.warning("connect %s to %s: %s", gw, name, e)
    return net


def _create_network(name: str, repl_id: str):
    """Docker's default address pools run out after a few dozen networks, so
    carve a /28 per repl out of REPL_SUBNET_POOL ourselves."""
    import ipaddress

    import docker.errors
    from docker.types import IPAMConfig, IPAMPool

    client = docker_client()
    pool = ipaddress.ip_network(settings.REPL_SUBNET_POOL)
    used = set()
    for net in client.networks.list(filters={"label": "replot.repl"}):
        for cfg in (net.attrs.get("IPAM") or {}).get("Config") or []:
            if cfg.get("Subnet"):
                used.add(cfg["Subnet"])
    for subnet in pool.subnets(new_prefix=28):
        if str(subnet) in used:
            continue
        ipam = IPAMConfig(pool_configs=[IPAMPool(subnet=str(subnet))])
        try:
            return client.networks.create(name, driver="bridge", ipam=ipam, labels={"replot.repl": repl_id})
        except docker.errors.APIError as e:
            msg = str(e)
            if "network with name" in msg and "already exists" in msg:
                # A concurrent start of the same repl created it first.
                return client.networks.get(name)
            if "overlap" in msg or "already" in msg:
                continue  # subnet taken by a concurrent create or outside our labels
            raise
    raise RuntimeError("No free subnets left for repl networks")


def reconnect_gateways() -> None:
    """After nginx/backend are recreated they lose their per-repl networks;
    reattach them so running repls stay reachable."""
    for net in docker_client().networks.list(filters={"label": "replot.repl"}):
        repl_id = net.attrs.get("Labels", {}).get("replot.repl")
        if repl_id:
            try:
                _ensure_network(repl_id)
            except Exception as e:
                log.warning("reconnect %s: %s", net.name, e)


def run_container(kwargs: dict):
    """containers.run, placing the container under REPL_CGROUP_PARENT when
    Docker accepts it. A daemon on the cgroupfs driver (or one that rejects
    the slice) gets the container under its default parent instead of a
    failed start."""
    import docker.errors

    global _cgroup_parent_broken
    if _cgroup_parent_broken:
        kwargs.pop("cgroup_parent", None)
    try:
        return docker_client().containers.run(**kwargs)
    except docker.errors.APIError as e:
        if "cgroup_parent" not in kwargs or "cgroup" not in str(e).lower():
            raise
        log.warning("cgroup parent %r rejected (%s); starting repls without it",
                    kwargs["cgroup_parent"], e)
        _cgroup_parent_broken = True
        try:
            docker_client().containers.get(kwargs["name"]).remove(force=True)
        except docker.errors.APIError:
            pass
        kwargs.pop("cgroup_parent")
        return docker_client().containers.run(**kwargs)


def _container_kwargs(repl_id: str, user_id: str | None) -> dict:
    from docker.types import LogConfig

    kwargs = dict(
        image=settings.RUNNER_IMAGE,
        name=container_name(repl_id),
        hostname=repl_id,
        detach=True,
        network=network_name(repl_id),
        volumes={f"{settings.repls_host_dir}/{repl_id}": {"bind": "/home/runner/app", "mode": "rw"}},
        mem_limit=settings.REPL_MEMORY,
        # No swap: a repl that hits its limit is OOM-killed inside its own
        # cgroup instead of pushing the host into swap.
        memswap_limit=settings.REPL_MEMORY,
        # If the host itself runs out of memory, the kernel should pick a
        # repl before anything else on the machine.
        oom_score_adj=800,
        nano_cpus=int(settings.REPL_CPUS * 1e9),
        pids_limit=settings.REPL_PIDS,
        # Everything in the container runs as uid 1000; it needs no capabilities.
        cap_drop=["ALL"],
        cap_add=[],
        security_opt=["no-new-privileges"],
        # /tmp is RAM (counted against the memory limit) and capped, so it
        # can't fill the host disk. exec: users compile into /tmp.
        tmpfs={"/tmp": f"rw,exec,nosuid,nodev,size={settings.REPL_TMPFS_SIZE},mode=1777"},
        # The container's stdout is the agent's; user code can write to it
        # via /proc/1/fd/1, so rotate it.
        log_config=LogConfig(type="json-file", config={
            "max-size": settings.REPL_LOG_MAX_SIZE, "max-file": str(settings.REPL_LOG_MAX_FILE)}),
        labels={"replot.repl": repl_id, "replot.user": str(user_id or "")},
        environment={"REPL_ID": repl_id, "REPLOT_AGENT_TOKEN": agent_token(repl_id)},
    )
    if settings.REPL_RUNTIME:
        kwargs["runtime"] = settings.REPL_RUNTIME
    if settings.REPL_CGROUP_PARENT:
        kwargs["cgroup_parent"] = settings.REPL_CGROUP_PARENT
    return kwargs


# ---- disk usage ----


def repl_dir_bytes(repl_id: str) -> int:
    """Disk blocks used by the repl's directory (sparse files count as what
    they occupy, not their apparent size)."""
    path = os.path.join(settings.REPLS_DIR, repl_id)
    try:
        p = subprocess.run(["du", "-s", "-x", "-B1", path], capture_output=True, text=True, timeout=60)
        if p.stdout:
            return int(p.stdout.split()[0])
    except (OSError, subprocess.TimeoutExpired, ValueError, IndexError):
        pass
    total = 0
    for root, dirs, files in os.walk(path):
        for n in dirs + files:
            try:
                total += os.lstat(os.path.join(root, n)).st_blocks * 512
            except OSError:
                pass
    return total


def _quota_bytes() -> int:
    return settings.REPL_DISK_QUOTA_MB * 1024 * 1024


def _check_quota(repl_id: str) -> None:
    if settings.REPL_DISK_QUOTA_MB <= 0:
        return
    used = repl_dir_bytes(repl_id)
    if used > _quota_bytes():
        raise HTTPException(
            status_code=507,
            detail=(f"This repl uses {used // (1024 * 1024)} MB of disk, over the "
                    f"{settings.REPL_DISK_QUOTA_MB} MB limit. Delete files (build output, "
                    f"node_modules, caches) before starting it."))


# ---- start / stop ----


def _running() -> list:
    return docker_client().containers.list(filters={"label": "replot.repl", "status": "running"})


def _created_ts(c) -> float:
    created = c.attrs.get("Created")
    if isinstance(created, (int, float)):
        return float(created)
    # Inspect returns RFC 3339 with nanoseconds ("2026-10-09T13:37:43.123456789Z").
    try:
        whole = str(created).rstrip("Z").split(".")[0]
        return datetime.fromisoformat(whole).replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        return time.time()


def _ensure_started(repl_id: str, user_id: str | None = None) -> list[str]:
    """Start the repl's container. Returns the ids of the starting user's
    other repls that were stopped to stay under MAX_RUNNING_PER_USER."""
    with _lock_for(repl_id):
        victims = _ensure_started_locked(repl_id, user_id)
    for vid in victims:
        log.info("stopping repl %s: user %s is at MAX_RUNNING_PER_USER", vid, user_id)
        try:
            _stop(vid)
        except Exception as e:
            log.warning("stop %s failed: %s", vid, e)
        last_active.pop(vid, None)
    return victims


def _ensure_started_locked(repl_id: str, user_id: str | None) -> list[str]:
    c = _get(repl_id)
    if c is not None and network_name(repl_id) not in c.attrs.get("NetworkSettings", {}).get("Networks", {}):
        # Created before per-repl networks existed; containers are disposable
        # (files live on the host), so recreate it on its own network.
        c.remove(force=True)
        c = None
    if c is not None and c.status == "running":
        _ensure_network(repl_id)
        return []
    if c is not None:
        # Exited/created leftovers are recreated so they pick up current limits.
        c.remove(force=True)
    _check_quota(repl_id)
    _ensure_network(repl_id)
    with _caps_lock:
        others = [x for x in _running() if x.labels.get("replot.repl") != repl_id]
        victims = []
        if user_id and settings.MAX_RUNNING_PER_USER > 0:
            mine = [x for x in others if x.labels.get("replot.user") == str(user_id)]
            excess = len(mine) - (settings.MAX_RUNNING_PER_USER - 1)
            if excess > 0:
                mine.sort(key=lambda x: (last_active.get(x.labels["replot.repl"], float("-inf")), _created_ts(x)))
                victims = [x.labels["replot.repl"] for x in mine[:excess]]
        if settings.MAX_RUNNING_REPLS > 0 and len(others) - len(victims) >= settings.MAX_RUNNING_REPLS:
            raise HTTPException(
                status_code=503,
                detail=(f"The server is at capacity ({settings.MAX_RUNNING_REPLS} running repls). "
                        "Try again in a few minutes."))
        run_container(_container_kwargs(repl_id, user_id))
    return victims


def _stop(repl_id: str) -> None:
    with _lock_for(repl_id):
        _stop_locked(repl_id)


def _stop_locked(repl_id: str) -> None:
    # Containers are disposable (files live on the host), so a stopped repl
    # gives back its container and its network/subnet; start recreates both.
    c = _get(repl_id)
    if c is not None and c.status == "running":
        c.stop(timeout=5)
    _remove(repl_id)


def _remove(repl_id: str) -> None:
    import docker.errors

    c = _get(repl_id)
    if c is not None:
        c.remove(force=True)
    try:
        net = docker_client().networks.get(network_name(repl_id))
        for gw in settings.GATEWAY_CONTAINERS.split(","):
            if gw.strip():
                try:
                    net.disconnect(gw.strip(), force=True)
                except docker.errors.APIError:
                    pass
        net.remove()
    except docker.errors.NotFound:
        pass
    except docker.errors.APIError as e:
        log.warning("remove network for %s: %s", repl_id, e)


def _status(repl_id: str) -> str:
    c = _get(repl_id)
    # No container is the normal resting state: _stop() removes it.
    return "running" if c is not None and c.status == "running" else "stopped"


async def status(repl_id: str) -> str:
    try:
        return await run_in_threadpool(_status, repl_id)
    except Exception as e:  # docker unavailable
        log.warning("docker status failed: %s", e)
        return "missing"


async def start(repl_id: str, user_id: str | None = None) -> list[str]:
    """Start (or keep) the repl's container and wait for its agent. Returns
    the ids of repls stopped to keep `user_id` under MAX_RUNNING_PER_USER."""
    try:
        stopped = await run_in_threadpool(_ensure_started, repl_id, user_id)
    except HTTPException:
        raise
    except Exception as e:
        log.exception("failed to start container")
        raise HTTPException(status_code=500, detail=f"Failed to start container: {e}")
    touch_editor(repl_id)
    deadline = time.monotonic() + 30
    async with httpx.AsyncClient(timeout=2, headers=agent_headers(repl_id)) as client:
        while time.monotonic() < deadline:
            try:
                r = await client.get(agent_url(repl_id, "/health"))
                if r.status_code == 200:
                    return stopped
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
        async with httpx.AsyncClient(timeout=3, headers=agent_headers(repl_id)) as client:
            r = await client.get(agent_url(repl_id, "/ports"))
            if r.status_code == 200:
                result["ports"] = [int(p) for p in r.json().get("ports", [])]
    except (httpx.HTTPError, ValueError):
        pass
    return result


# ---- reaper ----


def _running_info() -> list[dict]:
    out = []
    for c in _running():
        rid = c.labels.get("replot.repl")
        if rid:
            out.append({"id": rid, "created": _created_ts(c)})
    return out


def _over_quota() -> list[tuple[str, int, int]]:
    """(repl id, directory bytes, writable-layer bytes) for running repls over
    REPL_DISK_QUOTA_MB. SizeRw is the container's own writes outside the bind
    mount and /tmp (~/.cache, ~/.local, ...)."""
    if settings.REPL_DISK_QUOTA_MB <= 0:
        return []
    over = []
    listed = docker_client().api.containers(filters={"label": "replot.repl", "status": "running"}, size=True)
    for c in listed:
        rid = (c.get("Labels") or {}).get("replot.repl")
        if not rid:
            continue
        rw = int(c.get("SizeRw") or 0)
        used = repl_dir_bytes(rid)
        if used + rw > _quota_bytes():
            over.append((rid, used, rw))
    return over


async def reap_once() -> None:
    try:
        running = await run_in_threadpool(_running_info)
    except Exception as e:
        log.warning("reaper: docker list failed: %s", e)
        return
    now = time.monotonic()
    wall = time.time()
    timeout = settings.IDLE_TIMEOUT_MINUTES * 60
    max_age = settings.MAX_CONTAINER_HOURS * 3600
    to_stop: dict[str, str] = {}
    async with httpx.AsyncClient(timeout=3) as client:
        for info in running:
            rid = info["id"]
            if max_age > 0 and wall - info["created"] > max_age:
                to_stop[rid] = f"running for more than {settings.MAX_CONTAINER_HOURS:g} h"
                continue
            editors = 0
            try:
                r = await client.get(agent_url(rid, "/health"), headers=agent_headers(rid))
                body = r.json()
                # Older agents only report a total.
                editors = int(body.get("editors", body.get("clients", 0)) or 0)
            except Exception:
                pass
            if editors > 0:
                last_active[rid] = now
                continue
            if rid not in last_active:
                # first sighting (e.g. after backend restart): start the clock now
                last_active[rid] = now
                continue
            if now - last_active[rid] > timeout:
                to_stop[rid] = "idle"
    try:
        for rid, used, rw in await run_in_threadpool(_over_quota):
            to_stop.setdefault(rid, f"over disk quota: {used // 2**20} MB files + {rw // 2**20} MB "
                                    f"container layer > {settings.REPL_DISK_QUOTA_MB} MB")
    except Exception as e:
        log.warning("reaper: disk check failed: %s", e)
    for rid, why in to_stop.items():
        log.info("reaper: stopping repl %s (%s)", rid, why)
        try:
            await run_in_threadpool(_stop, rid)
        except Exception as e:
            log.warning("reaper: stop %s failed: %s", rid, e)
        last_active.pop(rid, None)


async def reaper_loop() -> None:
    while True:
        try:
            await run_in_threadpool(reconnect_gateways)
        except Exception:
            log.exception("reconnecting gateways failed")
        try:
            await reap_once()
        except Exception:
            log.exception("reaper iteration failed")
        try:
            from app.services import gitops

            await run_in_threadpool(gitops.remove_stale_sandboxes)
        except Exception as e:
            log.warning("reaper: git sandbox sweep failed: %s", e)
        await asyncio.sleep(60)
