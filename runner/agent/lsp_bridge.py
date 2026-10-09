"""WebSocket <-> stdio bridge for language servers.

    WS /lsp/{server}

One language server process per connection, started from the entry for
`server` in lsp/*.json. Each WebSocket text frame carries exactly one
JSON-RPC message; the bridge adds and strips LSP's Content-Length framing.

The bridge also keeps per-language knowledge out of the browser:
  * `initializationOptions` from the spec are merged into the client's
    `initialize` request;
  * the server's `workspace/configuration` requests are answered from the
    entry's `settings`, and the same settings are pushed with
    `workspace/didChangeConfiguration` once the client sends `initialized`.
"""
import asyncio
import json
import os
import signal
import time

from aiohttp import WSMsgType, web

SERVERS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lsp")
APP_DIR = "/home/runner/app"
MAX_MESSAGE = 64 * 1024 * 1024

# Memory guard. A language server whose process group grows past its limit
# (spec "maxMemoryMB", default below) is killed, and the server is refused
# for COOLDOWN seconds so the editor's reconnect loop can't restart a runaway
# over and over. The container's own 2 GB cgroup is the hard backstop; this
# keeps one server from starving the user's program and shell first.
DEFAULT_MAX_MEMORY_MB = 1280
MEMORY_POLL_SECONDS = 2.0
COOLDOWN_SECONDS = 300
_PAGE = os.sysconf("SC_PAGE_SIZE")
_cooldown_until: dict[str, float] = {}


def _group_rss_mb(pgid: int) -> int:
    """Resident memory of every process in a process group, in MB."""
    total = 0
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/stat") as f:
                stat = f.read()
            # Fields after the ")" that closes the command name: state is the
            # 1st, pgrp the 3rd.
            if int(stat[stat.rindex(")") + 2:].split()[2]) != pgid:
                continue
            with open(f"/proc/{entry}/statm") as f:
                total += int(f.read().split()[1]) * _PAGE
        except (OSError, ValueError, IndexError):
            continue
    return total // (1024 * 1024)


def load_servers() -> dict:
    """Merge lsp/*.json; each file maps server name -> launch spec."""
    servers = {}
    try:
        names = sorted(n for n in os.listdir(SERVERS_DIR) if n.endswith(".json"))
    except OSError:
        return servers
    for n in names:
        try:
            with open(os.path.join(SERVERS_DIR, n)) as f:
                servers.update(json.load(f))
        except (OSError, ValueError) as e:
            print(f"lsp: ignoring {n}: {e}", flush=True)
    return servers


def _deep_merge(base, extra):
    if isinstance(base, dict) and isinstance(extra, dict):
        out = dict(base)
        for k, v in extra.items():
            out[k] = _deep_merge(base.get(k), v) if k in base else v
        return out
    return extra if extra is not None else base


def _section(settings: dict, section):
    """Resolve a dotted configuration section ("python.analysis") or the
    whole settings object when no section is given."""
    if not section:
        return settings
    node = settings
    for part in section.split("."):
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node


class LanguageServer:
    def __init__(self, name: str, spec: dict, env: dict):
        self.name = name
        self.spec = spec
        self.env = env
        self.proc = None

    async def start(self):
        env = dict(self.env)
        env.update(self.spec.get("env", {}))
        log = open(f"/tmp/lsp-{self.name}.log", "ab")
        self.proc = await asyncio.create_subprocess_exec(
            *self.spec["command"],
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=log,
            cwd=APP_DIR if os.path.isdir(APP_DIR) else "/home/runner",
            env=env,
            start_new_session=True,
            limit=MAX_MESSAGE,
        )
        log.close()

    async def read_message(self):
        """Read one framed message from the server; None at EOF."""
        length = None
        while True:
            line = await self.proc.stdout.readline()
            if not line:
                return None
            line = line.strip()
            if not line:
                if length is not None:
                    break
                continue
            name, _, value = line.decode("ascii", "replace").partition(":")
            if name.lower() == "content-length":
                length = int(value.strip())
        body = await self.proc.stdout.readexactly(length)
        return body.decode("utf-8", "replace")

    def write_message(self, obj) -> None:
        body = json.dumps(obj, separators=(",", ":")).encode()
        self.proc.stdin.write(b"Content-Length: %d\r\n\r\n" % len(body) + body)

    def kill(self):
        if self.proc and self.proc.returncode is None:
            try:
                os.killpg(self.proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


def make_handler(child_env, on_open, on_close):
    async def lsp_ws(request):
        name = request.match_info["server"]
        spec = load_servers().get(name)
        if spec is None:
            raise web.HTTPNotFound(text=f"unknown language server {name!r}")
        wait = _cooldown_until.get(name, 0) - time.monotonic()
        if wait > 0:
            # The editor's probe reads this status and stops retrying.
            raise web.HTTPServiceUnavailable(
                text=f"{name} was stopped for using too much memory; retry in {int(wait)}s")
        ws = web.WebSocketResponse(heartbeat=30, max_msg_size=MAX_MESSAGE)
        await ws.prepare(request)
        on_open()
        settings = spec.get("settings", {})
        server = LanguageServer(name, spec, child_env())

        async def pump_from_server():
            while True:
                raw = await server.read_message()
                if raw is None:
                    break
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                if msg.get("method") == "workspace/configuration" and "id" in msg:
                    items = (msg.get("params") or {}).get("items") or []
                    server.write_message({
                        "jsonrpc": "2.0", "id": msg["id"],
                        "result": [_section(settings, i.get("section")) for i in items],
                    })
                    await server.proc.stdin.drain()
                    continue
                await ws.send_str(raw)
            await ws.close(code=1011, message=b"language server exited")

        async def watch_memory():
            limit = int(spec.get("maxMemoryMB", DEFAULT_MAX_MEMORY_MB))
            while server.proc and server.proc.returncode is None:
                await asyncio.sleep(MEMORY_POLL_SECONDS)
                rss = _group_rss_mb(server.proc.pid)
                if rss <= limit:
                    continue
                print(f"lsp: {name} using {rss} MB (limit {limit} MB); stopping it", flush=True)
                _cooldown_until[name] = time.monotonic() + COOLDOWN_SECONDS
                try:
                    await ws.send_str(json.dumps({
                        "jsonrpc": "2.0", "method": "window/showMessage",
                        "params": {"type": 1, "message":
                                   f"The {name} language server was stopped because it used "
                                   f"{rss} MB of memory (limit {limit} MB). Intellisense for this "
                                   f"language is off for {COOLDOWN_SECONDS // 60} minutes."}}))
                except ConnectionResetError:
                    pass
                server.kill()
                return

        pump = None
        watchdog = None
        try:
            try:
                await server.start()
            except (OSError, ValueError) as e:
                await ws.close(code=1011, message=f"cannot start {name}: {e}".encode()[:120])
                return ws
            pump = asyncio.create_task(pump_from_server())
            watchdog = asyncio.create_task(watch_memory())
            async for frame in ws:
                if frame.type != WSMsgType.TEXT:
                    continue
                try:
                    msg = json.loads(frame.data)
                except ValueError:
                    continue
                method = msg.get("method") if isinstance(msg, dict) else None
                if method == "initialize":
                    params = msg.setdefault("params", {})
                    params["initializationOptions"] = _deep_merge(
                        params.get("initializationOptions") or {}, spec.get("initializationOptions") or {})
                server.write_message(msg)
                if method == "initialized" and settings:
                    server.write_message({"jsonrpc": "2.0", "method": "workspace/didChangeConfiguration",
                                          "params": {"settings": settings}})
                await server.proc.stdin.drain()
        except (ConnectionResetError, BrokenPipeError):
            pass
        finally:
            if pump:
                pump.cancel()
            if watchdog:
                watchdog.cancel()
            server.kill()
            on_close()
        return ws

    return lsp_ws
