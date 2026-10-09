# Vue: @vue/language-server (Volar) in hybrid mode.
#
# Since v3 the Vue server only handles the Vue-specific parts of a .vue file;
# everything TypeScript (script types, template expressions, completions,
# most diagnostics) comes from a tsserver loaded with @vue/typescript-plugin,
# which the *client* is expected to run and to relay `tsserver/request`
# notifications to. The editor talks to one server per file, so
# vue-hybrid.py plays that client: it runs vue-language-server next to
# typescript-language-server (from 31-typescript.sh, with the Vue plugin) and
# presents both as a single language server.
VUE_LS_VERSION=3.3.12
TYPESCRIPT_VERSION=6.0.3   # same as 31-typescript.sh
dir=/opt/lsp/vue
test -x /opt/lsp/typescript/bin/typescript-language-server
mkdir -p "$dir"
cat > "$dir/package.json" <<JSON
{
  "private": true,
  "dependencies": {
    "@vue/language-server": "${VUE_LS_VERSION}",
    "@vue/typescript-plugin": "${VUE_LS_VERSION}",
    "typescript": "${TYPESCRIPT_VERSION}"
  }
}
JSON
(cd "$dir" && npm install --no-fund --no-audit --omit=dev)

cat > "$dir/vue-hybrid.py" <<'PY'
#!/usr/bin/env python3
"""Vue "hybrid mode" behind a single LSP endpoint.

@vue/language-server (v3) covers only the Vue-specific parts of a .vue file
and expects the *client* to run a TypeScript server loaded with
@vue/typescript-plugin, relaying its `tsserver/request` notifications there.
The editor talks to one server per connection, so this process is that client:
it runs vue-language-server and typescript-language-server side by side,
forwards document sync to both, merges completion/hover/diagnostics/code
actions, routes other requests to whichever server answers, and relays
`tsserver/request` -> `typescript.tsserverRequest` -> `tsserver/response`.
"""
import asyncio
import itertools
import json
import os
import sys

ROOT = "/opt/lsp/vue"
TS_ROOT = "/opt/lsp/typescript"
TSDK = f"{TS_ROOT}/node_modules/typescript/lib"
COMMANDS = {
    "vue": ["node", f"{ROOT}/node_modules/@vue/language-server/bin/vue-language-server.js", "--stdio"],
    "ts": [f"{TS_ROOT}/bin/typescript-language-server", "--stdio"],
}
INIT_OPTIONS = {
    "vue": {"typescript": {"tsdk": TSDK}},
    "ts": {
        # One tsserver instead of a syntax + semantic pair, and no typings
        # installer: Vue projects get their types from node_modules.
        "tsserver": {"path": TSDK, "useSyntaxServer": "never"},
        "disableAutomaticTypingAcquisition": True,
        "maxTsServerMemory": 768,
        "plugins": [{"name": "@vue/typescript-plugin", "location": ROOT, "languages": ["vue"]}],
        "preferences": {
            "includeCompletionsForModuleExports": True,
            "includeCompletionsWithInsertText": True,
            "includeCompletionsForImportStatements": True,
            "includeAutomaticOptionalChainCompletions": True,
            "allowIncompleteCompletions": True,
        },
    },
}
# Requests answered by Vue first (template/markup features), then TypeScript.
VUE_FIRST = {
    "textDocument/documentSymbol", "textDocument/foldingRange", "textDocument/documentLink",
    "textDocument/documentColor", "textDocument/colorPresentation", "textDocument/linkedEditingRange",
    "textDocument/formatting", "textDocument/rangeFormatting", "textDocument/onTypeFormatting",
    "textDocument/selectionRange", "textDocument/semanticTokens/full", "textDocument/semanticTokens/range",
    "textDocument/semanticTokens/full/delta", "documentLink/resolve",
}
MERGED = {"textDocument/completion", "textDocument/hover", "textDocument/codeAction"}
TAG = "__vuemux"

out_lock = asyncio.Lock()


def log(*a):
    print("vue-hybrid:", *a, file=sys.stderr, flush=True)


async def read_message(reader):
    length = None
    while True:
        line = await reader.readline()
        if not line:
            return None
        line = line.strip()
        if not line:
            if length is not None:
                break
            continue
        k, _, v = line.decode("ascii", "replace").partition(":")
        if k.lower() == "content-length":
            length = int(v.strip())
    return json.loads(await reader.readexactly(length))


def frame(msg) -> bytes:
    body = json.dumps(msg, separators=(",", ":")).encode()
    return b"Content-Length: %d\r\n\r\n" % len(body) + body


async def to_client(msg):
    async with out_lock:
        sys.stdout.buffer.write(frame(msg))
        sys.stdout.buffer.flush()


class Server:
    def __init__(self, name):
        self.name = name
        self.ids = itertools.count(1)
        self.pending: dict[int, asyncio.Future] = {}
        self.caps = {}
        self.proc = None

    async def start(self):
        self.proc = await asyncio.create_subprocess_exec(
            *COMMANDS[self.name], stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            limit=64 * 1024 * 1024)

    def send(self, msg):
        self.proc.stdin.write(frame(msg))


servers = {"vue": Server("vue"), "ts": Server("ts")}
# client request id -> {server name: server request id}, for $/cancelRequest
inflight: dict = {}
# id we gave a server->client request -> (server, server's id)
reverse: dict = {}
reverse_ids = itertools.count(1)
diagnostics: dict = {}  # uri -> {server: [diag]}


def empty(r):
    return r is None or r == [] or (isinstance(r, dict) and "items" in r and not r["items"])


def tag(obj, name):
    obj["data"] = {TAG: name, "d": obj.get("data")}
    return obj


def untag(obj):
    d = obj.get("data")
    if isinstance(d, dict) and TAG in d:
        obj = dict(obj)
        name = d[TAG]
        obj["data"] = d["d"]
        if obj["data"] is None:
            del obj["data"]
        return name, obj
    return None, obj


def completion_items(res, name):
    if res is None:
        return [], False
    if isinstance(res, list):
        items, incomplete, defaults = res, False, {}
    else:
        items, incomplete, defaults = res.get("items") or [], bool(res.get("isIncomplete")), res.get("itemDefaults") or {}
    out = []
    for it in items:
        it = dict(it)
        for k, v in defaults.items():
            if k == "editRange":
                if "textEdit" not in it:
                    text = it.get("textEditText") or it.get("insertText") or it["label"]
                    it["textEdit"] = ({"newText": text, **v} if "insert" in v else {"newText": text, "range": v})
            elif k not in it:
                it[k] = v
        it.pop("textEditText", None)
        out.append(tag(it, name))
    return out, incomplete


def hover_text(h):
    if not h:
        return None
    c = h.get("contents")
    parts = c if isinstance(c, list) else [c]
    texts = []
    for p in parts:
        if isinstance(p, str):
            texts.append(p)
        elif isinstance(p, dict) and "language" in p:
            texts.append(f"```{p['language']}\n{p['value']}\n```")
        elif isinstance(p, dict):
            texts.append(p.get("value", ""))
    t = "\n\n".join(x for x in texts if x.strip())
    return t or None


async def ask(name, method, params, cid):
    s = servers[name]
    if s.proc is None:
        return None
    i = next(s.ids)
    fut = asyncio.get_running_loop().create_future()
    s.pending[i] = fut
    if cid is not None:
        inflight.setdefault(cid, {})[name] = i
    s.send({"jsonrpc": "2.0", "id": i, "method": method, "params": params})
    await s.proc.stdin.drain()
    try:
        msg = await fut
    finally:
        s.pending.pop(i, None)
    if "error" in msg:
        return None
    return msg.get("result")


async def handle_request(msg):
    cid, method, params = msg["id"], msg["method"], msg.get("params")
    result, error = None, None
    try:
        if method == "initialize":
            results = {}
            for name in servers:
                p = dict(params or {})
                p["initializationOptions"] = INIT_OPTIONS[name]
                r = await ask(name, "initialize", p, None)
                servers[name].caps = (r or {}).get("capabilities") or {}
            result = {"capabilities": merge_caps(), "serverInfo": {"name": "vue-language-server (hybrid)",
                                                                    "version": vue_version()}}
        elif method == "shutdown":
            await asyncio.gather(*(ask(n, "shutdown", None, None) for n in servers))
        elif method in ("completionItem/resolve", "codeAction/resolve"):
            name, item = untag(params)
            r = await ask(name or "ts", method, item, cid)
            result = tag(r, name) if isinstance(r, dict) and name else r
        elif method == "textDocument/completion":
            rs = await asyncio.gather(*(ask(n, method, params, cid) for n in ("ts", "vue")))
            items, inc = [], False
            for name, r in zip(("ts", "vue"), rs):
                it, i = completion_items(r, name)
                items += it
                inc = inc or i
            result = {"isIncomplete": inc, "items": items}
        elif method == "textDocument/hover":
            rs = await asyncio.gather(*(ask(n, method, params, cid) for n in ("ts", "vue")))
            texts = [t for t in map(hover_text, rs) if t]
            if texts:
                rng = next((r.get("range") for r in rs if r and r.get("range")), None)
                result = {"contents": {"kind": "markdown", "value": "\n\n---\n\n".join(texts)}}
                if rng:
                    result["range"] = rng
        elif method == "textDocument/codeAction":
            rs = await asyncio.gather(*(ask(n, method, params, cid) for n in ("ts", "vue")))
            result = []
            for name, r in zip(("ts", "vue"), rs):
                for a in r or []:
                    result.append(tag(dict(a), name) if "data" in a else a)
        elif method == "workspace/executeCommand":
            cmd = (params or {}).get("command")
            name = "ts" if cmd in ((servers["ts"].caps.get("executeCommandProvider") or {}).get("commands") or []) else "vue"
            result = await ask(name, method, params, cid)
        else:
            order = ("vue", "ts") if method in VUE_FIRST else ("ts", "vue")
            for name in order:
                result = await ask(name, method, params, cid)
                if not empty(result):
                    break
    except Exception as e:  # noqa: BLE001
        log("request failed", method, repr(e))
        error = {"code": -32603, "message": str(e)}
    finally:
        inflight.pop(cid, None)
    reply = {"jsonrpc": "2.0", "id": cid}
    if error:
        reply["error"] = error
    else:
        reply["result"] = result
    await to_client(reply)


def vue_version():
    try:
        with open(f"{ROOT}/node_modules/@vue/language-server/package.json") as f:
            return json.load(f)["version"]
    except (OSError, ValueError, KeyError):
        return ""


def merge_caps():
    ts, vue = servers["ts"].caps, servers["vue"].caps
    caps = dict(ts)
    for k, v in vue.items():
        caps.setdefault(k, v)
    def sync_kind(c):
        s = c.get("textDocumentSync")
        return s.get("change", 1) if isinstance(s, dict) else (s or 1)
    caps["textDocumentSync"] = {"openClose": True, "change": min(sync_kind(ts), sync_kind(vue)),
                                "save": {"includeText": False}}
    cp = [c for c in (ts.get("completionProvider"), vue.get("completionProvider")) if c]
    if cp:
        caps["completionProvider"] = {
            "triggerCharacters": sorted({t for c in cp for t in c.get("triggerCharacters") or []}),
            "resolveProvider": any(c.get("resolveProvider") for c in cp),
        }
    sh = [c for c in (ts.get("signatureHelpProvider"), vue.get("signatureHelpProvider")) if c]
    if sh:
        caps["signatureHelpProvider"] = {
            "triggerCharacters": sorted({t for c in sh for t in c.get("triggerCharacters") or []}),
            "retriggerCharacters": sorted({t for c in sh for t in c.get("retriggerCharacters") or []}),
        }
    cmds = [c for s in (ts, vue) for c in ((s.get("executeCommandProvider") or {}).get("commands") or [])]
    if cmds:
        caps["executeCommandProvider"] = {"commands": sorted(set(cmds))}
    if "semanticTokensProvider" in vue:
        caps["semanticTokensProvider"] = vue["semanticTokensProvider"]
    caps.pop("diagnosticProvider", None)
    return caps


async def relay_tsserver(vue_params):
    """vue -> tsserver/request [[id, command, args]] ; reply tsserver/response [[id, body]]."""
    reqs = vue_params if vue_params and isinstance(vue_params[0], list) else [vue_params]

    async def one(req):
        rid, command, args = req[0], req[1], req[2] if len(req) > 2 else None
        r = await ask("ts", "workspace/executeCommand",
                      {"command": "typescript.tsserverRequest", "arguments": [command, args]}, None)
        body = r.get("body") if isinstance(r, dict) else r
        servers["vue"].send({"jsonrpc": "2.0", "method": "tsserver/response", "params": [[rid, body]]})
        await servers["vue"].proc.stdin.drain()

    await asyncio.gather(*(one(r) for r in reqs if r))


async def pump(name):
    s = servers[name]
    while True:
        msg = await read_message(s.proc.stdout)
        if msg is None:
            log(name, "exited")
            os._exit(1)
        if "id" in msg and "method" not in msg:
            fut = s.pending.get(msg["id"])
            if fut and not fut.done():
                fut.set_result(msg)
        elif "id" in msg:
            nid = f"mux-{next(reverse_ids)}"
            reverse[nid] = (name, msg["id"])
            await to_client({**msg, "id": nid})
        else:
            method = msg.get("method")
            if method == "tsserver/request" and name == "vue":
                asyncio.create_task(relay_tsserver(msg.get("params")))
            elif method == "textDocument/publishDiagnostics":
                p = msg["params"]
                per = diagnostics.setdefault(p["uri"], {})
                per[name] = p.get("diagnostics") or []
                await to_client({"jsonrpc": "2.0", "method": method, "params": {
                    "uri": p["uri"], "diagnostics": [d for v in per.values() for d in v]}})
            else:
                await to_client(msg)


async def main():
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=64 * 1024 * 1024)
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    for s in servers.values():
        await s.start()
        asyncio.create_task(pump(s.name))
    while True:
        msg = await read_message(reader)
        if msg is None:
            break
        if "method" in msg and "id" in msg:
            asyncio.create_task(handle_request(msg))
        elif "method" in msg:
            method = msg["method"]
            if method == "$/cancelRequest":
                for name, sid in (inflight.get((msg.get("params") or {}).get("id")) or {}).items():
                    servers[name].send({"jsonrpc": "2.0", "method": method, "params": {"id": sid}})
                continue
            for s in servers.values():
                s.send(msg)
                await s.proc.stdin.drain()
            if method == "exit":
                break
        else:  # response to a server->client request we forwarded
            target = reverse.pop(msg.get("id"), None)
            if target:
                name, sid = target
                servers[name].send({**msg, "id": sid})
                await servers[name].proc.stdin.drain()
    for s in servers.values():
        if s.proc and s.proc.returncode is None:
            s.proc.kill()


if __name__ == "__main__":
    asyncio.run(main())
PY
chmod -R a+rX "$dir"
chmod 755 "$dir/vue-hybrid.py"
python3 -c "import ast,sys; ast.parse(open(sys.argv[1]).read())" "$dir/vue-hybrid.py"
node "$dir/node_modules/@vue/language-server/bin/vue-language-server.js" --version
