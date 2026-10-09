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

from aiohttp import WSMsgType, web

SERVERS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lsp")
APP_DIR = "/home/runner/app"
MAX_MESSAGE = 64 * 1024 * 1024


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

        pump = None
        try:
            try:
                await server.start()
            except (OSError, ValueError) as e:
                await ws.close(code=1011, message=f"cannot start {name}: {e}".encode()[:120])
                return ws
            pump = asyncio.create_task(pump_from_server())
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
            server.kill()
            on_close()
        return ws

    return lsp_ws
