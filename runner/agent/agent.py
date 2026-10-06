#!/usr/bin/env python3
"""Replot in-container agent.

Listens on 0.0.0.0:8008 and exposes:
  GET /health  -> {"ok": true, "clients": N}
  GET /ports   -> {"ports": [...]}  TCP ports in LISTEN state (minus our own)
  WS  /run     -> the single shared Run process (scrollback replay + status)
  WS  /shell   -> a fresh `bash -l` PTY per connection

Only aiohttp + stdlib.
"""
import asyncio
import codecs
import fcntl
import json
import os
import re
import shlex
import signal
import struct
import termios
import tomllib

from aiohttp import WSMsgType, web

APP_DIR = "/home/runner/app"
REPLIT_FILE = os.path.join(APP_DIR, ".replit")
SCROLLBACK_LIMIT = 256 * 1024
EXCLUDED_PORTS = {8008, 6080, 5900}
DEFAULT_PORT = 8000

DIM = "\x1b[2m"
RESET = "\x1b[0m"

# Fallback run commands when .replit has no `run`, checked in order.
FALLBACKS = [
    ("main.py", "python3 main.py"),
    ("index.js", "node index.js"),
    ("main.js", "node main.js"),
    ("index.ts", "tsx index.ts"),
    ("main.ts", "tsx main.ts"),
    ("Main.java", "javac Main.java && java Main"),
    ("main.kt", "kotlinc main.kt -include-runtime -d main.jar 2>/dev/null && java -jar main.jar"),
    ("main.c", "gcc -o main main.c -lm && ./main"),
    ("main.cpp", "g++ -std=c++17 -o main main.cpp && ./main"),
    ("Cargo.toml", "cargo run -q"),
    ("go.mod", "go run ."),
    ("main.go", "go run main.go"),
    ("main.rb", "ruby main.rb"),
    ("index.php", "php index.php"),
    ("main.php", "php main.php"),
    ("main.lua", "lua5.4 main.lua"),
    ("main.pl", "perl main.pl"),
    ("main.sh", "bash main.sh"),
    ("main.hs", "runghc main.hs"),
    ("main.r", "Rscript main.r"),
    ("main.R", "Rscript main.R"),
    ("index.html", "python3 -m http.server 8000 --bind 0.0.0.0"),
    ("package.json", "npm install && npm start"),
]

total_clients = 0


# ---------------------------------------------------------------- helpers

def read_replit():
    """Return the parsed .replit as a dict (best effort)."""
    try:
        with open(REPLIT_FILE, "rb") as f:
            raw = f.read()
    except OSError:
        return {}
    try:
        return tomllib.loads(raw.decode("utf-8", "replace"))
    except Exception:
        # Lenient fallback: key = "value" / key = 123 lines
        out = {}
        for line in raw.decode("utf-8", "replace").splitlines():
            m = re.match(r'\s*([A-Za-z_][\w-]*)\s*=\s*(.+?)\s*$', line)
            if not m:
                continue
            k, v = m.group(1), m.group(2)
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                v = v[1:-1]
            elif v.isdigit():
                v = int(v)
            out[k] = v
        return out


def resolve_run(cfg):
    run = cfg.get("run")
    if isinstance(run, list):
        run = " ".join(shlex.quote(str(x)) for x in run)
    if isinstance(run, str) and run.strip():
        return run.strip()
    for fname, cmd in FALLBACKS:
        if os.path.exists(os.path.join(APP_DIR, fname)):
            return cmd
    return None


def child_env(port=None):
    env = dict(os.environ)
    env.update({
        "TERM": "xterm-256color",
        "COLORTERM": "truecolor",
        "DISPLAY": ":0",
        "HOME": "/home/runner",
        "USER": "runner",
        "HOST": "0.0.0.0",
        "PORT": str(port or DEFAULT_PORT),
        "REPLOT": "1",
        "PYTHONUNBUFFERED": "1",
        "SDL_AUDIODRIVER": env.get("SDL_AUDIODRIVER", "dummy"),  # no sound card
    })
    return env


def set_winsize(fd, rows, cols):
    try:
        rows = max(1, min(int(rows), 1000))
        cols = max(1, min(int(cols), 1000))
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except Exception:
        pass


def _make_ctty():
    # Runs in the child after setsid(): make the PTY slave our controlling tty.
    try:
        fcntl.ioctl(0, termios.TIOCSCTTY, 0)
    except Exception:
        pass


class PtyProcess:
    """A process attached to a fresh PTY, in its own session/process group."""

    def __init__(self, argv, env, on_output, rows=24, cols=80):
        self.argv = argv
        self.env = env
        self.on_output = on_output
        self.rows, self.cols = rows, cols
        self.proc = None
        self.master = None
        self.decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        self._eof = asyncio.Event()

    async def start(self):
        master, slave = os.openpty()
        set_winsize(slave, self.rows, self.cols)
        os.set_blocking(master, False)
        try:
            self.proc = await asyncio.create_subprocess_exec(
                *self.argv,
                stdin=slave, stdout=slave, stderr=slave,
                cwd=APP_DIR if os.path.isdir(APP_DIR) else "/home/runner",
                env=self.env,
                start_new_session=True,
                preexec_fn=_make_ctty,
                close_fds=True,
            )
        except Exception:
            os.close(master)
            os.close(slave)
            raise
        os.close(slave)
        self.master = master
        asyncio.get_running_loop().add_reader(master, self._readable)

    @property
    def pid(self):
        return self.proc.pid if self.proc else None

    def _readable(self):
        try:
            data = os.read(self.master, 65536)
        except BlockingIOError:
            return
        except OSError:
            data = b""
        if not data:
            self._close_reader()
            tail = self.decoder.decode(b"", final=True)
            if tail:
                self.on_output(tail)
            return
        text = self.decoder.decode(data)
        if text:
            self.on_output(text)

    def _close_reader(self):
        if self.master is not None:
            try:
                asyncio.get_running_loop().remove_reader(self.master)
            except Exception:
                pass
        self._eof.set()

    async def wait(self):
        """Wait for exit, drain remaining output, return exit code."""
        code = await self.proc.wait()
        try:
            await asyncio.wait_for(self._eof.wait(), 1.0)
        except asyncio.TimeoutError:
            # e.g. a background child still holds the PTY open
            self._close_reader()
        if self.master is not None:
            try:
                os.close(self.master)
            except OSError:
                pass
            self.master = None
        return code

    def write(self, data):
        if self.master is None or not data:
            return
        b = data.encode("utf-8", "replace")
        try:
            while b:
                n = os.write(self.master, b)
                b = b[n:]
        except BlockingIOError:
            pass  # tty input buffer full; drop the rest
        except OSError:
            pass

    def resize(self, rows, cols):
        rows, cols = _dim(rows, 24), _dim(cols, 80)
        self.rows, self.cols = rows, cols
        if self.master is not None:
            set_winsize(self.master, rows, cols)

    def signal_group(self, sig):
        if not self.pid:
            return
        try:
            os.killpg(self.pid, sig)
        except (ProcessLookupError, PermissionError):
            try:
                os.kill(self.pid, sig)
            except Exception:
                pass

    @property
    def alive(self):
        return self.proc is not None and self.proc.returncode is None


class Client:
    """A websocket with an ordered outbound queue."""

    def __init__(self, ws):
        self.ws = ws
        self.queue = asyncio.Queue()
        self.task = asyncio.create_task(self._pump())

    async def _pump(self):
        while True:
            msg = await self.queue.get()
            if msg is None:
                return
            try:
                await self.ws.send_str(msg)
            except Exception:
                return

    def send(self, obj):
        self.queue.put_nowait(json.dumps(obj))

    def close(self):
        self.queue.put_nowait(None)


# ---------------------------------------------------------------- run manager

class RunManager:
    def __init__(self):
        self.clients = set()
        self.scrollback = []      # list of str chunks
        self.scrollback_len = 0
        self.proc = None
        self.command = None
        self.exit_code = None
        self.generation = 0
        self.rows, self.cols = 24, 80
        self.lock = asyncio.Lock()

    def status(self):
        return {
            "type": "status",
            "running": bool(self.proc and self.proc.alive),
            "exitCode": self.exit_code,
            "command": self.command,
        }

    def broadcast(self, obj):
        for c in list(self.clients):
            c.send(obj)

    def output(self, text):
        self.scrollback.append(text)
        self.scrollback_len += len(text)
        while self.scrollback_len > SCROLLBACK_LIMIT and len(self.scrollback) > 1:
            self.scrollback_len -= len(self.scrollback.pop(0))
        if self.scrollback_len > SCROLLBACK_LIMIT:
            s = self.scrollback[0][-SCROLLBACK_LIMIT:]
            self.scrollback = [s]
            self.scrollback_len = len(s)
        self.broadcast({"type": "output", "data": text})

    def replay(self):
        return "".join(self.scrollback)

    async def _kill_current(self):
        p = self.proc
        if p and p.alive:
            p.signal_group(signal.SIGKILL)
            try:
                await asyncio.wait_for(p.proc.wait(), 3)
            except asyncio.TimeoutError:
                pass

    async def start(self):
        async with self.lock:
            await self._kill_current()
            self.generation += 1
            gen = self.generation
            cfg = read_replit()
            cmd = resolve_run(cfg)
            if not cmd:
                self.command = None
                self.exit_code = None
                self.output(f"{DIM}No run command: add `run = \"...\"` to .replit{RESET}\r\n")
                self.broadcast(self.status())
                return
            port = cfg.get("port")
            if not isinstance(port, int):
                port = DEFAULT_PORT
            self.command = cmd
            self.exit_code = None
            self.output(f"\r\n{DIM}❯ {cmd}{RESET}\r\n")
            proc = PtyProcess(["bash", "-lc", cmd], child_env(port),
                              lambda t, g=gen: self._out_if_current(g, t),
                              self.rows, self.cols)
            try:
                await proc.start()
            except Exception as e:
                self.output(f"\x1b[31mfailed to start: {e}{RESET}\r\n")
                self.exit_code = -1
                self.broadcast(self.status())
                return
            self.proc = proc
            self.broadcast(self.status())
            asyncio.create_task(self._watch(proc, gen))

    def _out_if_current(self, gen, text):
        if gen == self.generation:
            self.output(text)

    async def _watch(self, proc, gen):
        code = await proc.wait()
        if gen != self.generation:
            return
        if code is not None and code < 0:
            try:
                name = signal.Signals(-code).name
            except Exception:
                name = f"signal {-code}"
            msg = f"terminated by {name}"
        else:
            msg = f"exit status {code}"
        colour = "\x1b[2m" if code == 0 else "\x1b[2;33m"
        self.output(f"\r\n{colour}→ {msg}{RESET}\r\n")
        self.exit_code = code
        self.broadcast(self.status())

    async def stop(self):
        async with self.lock:
            p = self.proc
            if not (p and p.alive):
                self.broadcast(self.status())
                return
            p.signal_group(signal.SIGTERM)
            p.signal_group(signal.SIGCONT)
            try:
                await asyncio.wait_for(asyncio.shield(p.proc.wait()), 2)
            except asyncio.TimeoutError:
                p.signal_group(signal.SIGKILL)

    def input(self, data):
        if self.proc and self.proc.alive:
            self.proc.write(data)

    def resize(self, rows, cols):
        rows, cols = _dim(rows, 24), _dim(cols, 80)
        self.rows, self.cols = rows, cols
        if self.proc:
            self.proc.resize(rows, cols)


RUN = RunManager()


# ---------------------------------------------------------------- handlers

def _dim(value, default):
    # A hidden xterm reports 0 or NaN (null in JSON); never let a bad resize
    # kill the socket and drop the messages queued behind it.
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return n if 1 <= n <= 1000 else default


def parse(msg):
    try:
        obj = json.loads(msg.data)
        return obj if isinstance(obj, dict) else None
    except Exception:
        return None


async def health(request):
    return web.json_response({"ok": True, "clients": total_clients})


def _is_loopback(addr_hex):
    # /proc/net addresses are little-endian hex. Loopback listeners (Docker's
    # embedded DNS on 127.0.0.11, x11vnc, servers bound to localhost) can't be
    # reached by the preview proxy, so they are not offered as web previews.
    if len(addr_hex) == 8:
        return addr_hex.endswith("7F")
    if addr_hex == "00000000000000000000000001000000":
        return True
    return addr_hex.startswith("0000000000000000FFFF0000") and addr_hex.endswith("7F")


def listening_ports():
    ports = set()
    for path in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            with open(path) as f:
                next(f, None)
                for line in f:
                    parts = line.split()
                    if len(parts) < 4 or parts[3] != "0A":
                        continue
                    addr, port_hex = parts[1].rsplit(":", 1)
                    port = int(port_hex, 16)
                    if port not in EXCLUDED_PORTS and not _is_loopback(addr):
                        ports.add(port)
        except OSError:
            pass
    return sorted(ports)


async def ports(request):
    return web.json_response({"ports": listening_ports()})


async def run_ws(request):
    global total_clients
    ws = web.WebSocketResponse(heartbeat=30, max_msg_size=4 * 1024 * 1024)
    await ws.prepare(request)
    client = Client(ws)
    total_clients += 1
    try:
        back = RUN.replay()
        if back:
            client.send({"type": "output", "data": back})
        client.send(RUN.status())
        RUN.clients.add(client)
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            obj = parse(msg)
            if not obj:
                continue
            t = obj.get("type")
            try:
                if t == "input":
                    RUN.input(str(obj.get("data", "")))
                elif t == "resize":
                    RUN.resize(obj.get("rows", 24), obj.get("cols", 80))
                elif t == "start":
                    asyncio.create_task(RUN.start())
                elif t == "stop":
                    asyncio.create_task(RUN.stop())
            except Exception as e:  # one bad message must not drop the socket
                print(f"run_ws: ignoring {t!r}: {e}", flush=True)
    finally:
        RUN.clients.discard(client)
        client.close()
        total_clients -= 1
    return ws


async def shell_ws(request):
    global total_clients
    ws = web.WebSocketResponse(heartbeat=30, max_msg_size=4 * 1024 * 1024)
    await ws.prepare(request)
    client = Client(ws)
    total_clients += 1
    try:
        rows = int(request.query.get("rows", 24))
        cols = int(request.query.get("cols", 80))
    except ValueError:
        rows, cols = 24, 80
    proc = PtyProcess(["bash", "-l"], child_env(read_replit().get("port")),
                      lambda t: client.send({"type": "output", "data": t}),
                      rows, cols)

    async def watch():
        code = await proc.wait()
        client.send({"type": "output", "data": f"\r\n{DIM}[shell exited: {code}]{RESET}\r\n"})
        client.close()
        await asyncio.sleep(0.2)
        await ws.close()

    watcher = None
    try:
        await proc.start()
        watcher = asyncio.create_task(watch())
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            obj = parse(msg)
            if not obj:
                continue
            t = obj.get("type")
            if t == "input":
                proc.write(str(obj.get("data", "")))
            elif t == "resize":
                proc.resize(obj.get("rows", 24), obj.get("cols", 80))
    except Exception as e:
        try:
            client.send({"type": "output", "data": f"\x1b[31magent error: {e}{RESET}\r\n"})
        except Exception:
            pass
    finally:
        total_clients -= 1
        if proc.alive:
            proc.signal_group(signal.SIGHUP)
            proc.signal_group(signal.SIGCONT)

            async def reap():
                await asyncio.sleep(1)
                if proc.alive:
                    proc.signal_group(signal.SIGKILL)
            asyncio.create_task(reap())
        client.close()
    return ws


def main():
    signal.signal(signal.SIGPIPE, signal.SIG_IGN)
    app = web.Application()
    app.router.add_get("/health", health)
    app.router.add_get("/ports", ports)
    app.router.add_get("/run", run_ws)
    app.router.add_get("/shell", shell_ws)
    web.run_app(app, host="0.0.0.0", port=8008, access_log=None, print=None,
                handle_signals=True)


if __name__ == "__main__":
    main()
