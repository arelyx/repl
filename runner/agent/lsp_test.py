#!/usr/bin/env python3
"""End-to-end check of one language server through the agent's /lsp bridge.

Runs *inside* a repl container (aiohttp is available there):

    python3 /opt/replagent/lsp_test.py SERVER FILE [--line N --col N] [--expect-error]
        [--expect-completion LABEL]

It opens FILE (relative to /home/runner/app) over ws://localhost:8008/lsp/SERVER,
then:
  * waits for textDocument/publishDiagnostics and prints them; with
    --expect-error, fails unless at least one diagnostic has severity Error;
  * requests completion at --line/--col (0-based) and prints the first labels;
    with --expect-completion, fails unless LABEL is among them;
  * requests hover at the same position and prints its first line.
Exit status 0 means every expectation held.
"""
import argparse
import asyncio
import json
import os
import sys

import aiohttp

ROOT = "/home/runner/app"
LANG_IDS = {
    ".py": "python", ".js": "javascript", ".jsx": "javascriptreact", ".ts": "typescript",
    ".tsx": "typescriptreact", ".c": "c", ".h": "c", ".cpp": "cpp", ".hpp": "cpp", ".cc": "cpp",
    ".java": "java", ".kt": "kotlin", ".cs": "csharp", ".go": "go", ".rs": "rust", ".rb": "ruby",
    ".php": "php", ".pl": "perl", ".lua": "lua", ".sh": "shellscript", ".hs": "haskell",
    ".r": "r", ".R": "r", ".f90": "fortran", ".pas": "pascal", ".asm": "nasm", ".scm": "scheme",
    ".lisp": "commonlisp", ".vue": "vue", ".html": "html", ".css": "css",
}


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("server")
    ap.add_argument("file")
    ap.add_argument("--line", type=int, default=0)
    ap.add_argument("--col", type=int, default=0)
    ap.add_argument("--expect-error", action="store_true")
    ap.add_argument("--expect-completion")
    ap.add_argument("--timeout", type=float, default=120)
    ap.add_argument("--url", default="ws://localhost:8008/lsp/")
    a = ap.parse_args()

    path = os.path.join(ROOT, a.file)
    text = open(path).read()
    uri = "file://" + path
    lang = LANG_IDS.get(os.path.splitext(path)[1], "plaintext")
    ok = True
    next_id = 0
    pending: dict[int, asyncio.Future] = {}
    diags: asyncio.Future = asyncio.get_running_loop().create_future()

    async with aiohttp.ClientSession() as s, s.ws_connect(a.url + a.server, max_msg_size=0) as ws:
        async def reader():
            async for m in ws:
                if m.type != aiohttp.WSMsgType.TEXT:
                    continue
                msg = json.loads(m.data)
                if "id" in msg and ("result" in msg or "error" in msg) and msg["id"] in pending:
                    pending.pop(msg["id"]).set_result(msg)
                elif "id" in msg and "method" in msg:  # server -> client request
                    result = None
                    if msg["method"] == "workspace/configuration":
                        result = [None for _ in msg["params"]["items"]]
                    await ws.send_str(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": result}))
                elif msg.get("method") == "textDocument/publishDiagnostics":
                    p = msg["params"]
                    if p["uri"] == uri and (p["diagnostics"] or a.expect_error is False) and not diags.done():
                        diags.set_result(p["diagnostics"])
            if not diags.done():
                diags.set_exception(RuntimeError(f"socket closed: {ws.close_code}"))

        async def request(method, params):
            nonlocal next_id
            next_id += 1
            fut = asyncio.get_running_loop().create_future()
            pending[next_id] = fut
            await ws.send_str(json.dumps({"jsonrpc": "2.0", "id": next_id, "method": method, "params": params}))
            return await asyncio.wait_for(fut, a.timeout)

        async def notify(method, params):
            await ws.send_str(json.dumps({"jsonrpc": "2.0", "method": method, "params": params}))

        rt = asyncio.create_task(reader())
        init = await request("initialize", {
            "processId": None, "rootUri": "file://" + ROOT, "rootPath": ROOT,
            "workspaceFolders": [{"uri": "file://" + ROOT, "name": "app"}],
            "capabilities": {
                "textDocument": {
                    "completion": {"completionItem": {"snippetSupport": True, "documentationFormat": ["markdown", "plaintext"]}},
                    "hover": {"contentFormat": ["markdown", "plaintext"]},
                    "publishDiagnostics": {"relatedInformation": True},
                    "synchronization": {"didSave": True},
                },
                "workspace": {"configuration": True, "workspaceFolders": True},
            },
        })
        if "error" in init:
            print("initialize failed:", init["error"])
            return 1
        caps = init["result"]["capabilities"]
        print("server:", (init["result"].get("serverInfo") or {}).get("name", a.server),
              (init["result"].get("serverInfo") or {}).get("version", ""))
        await notify("initialized", {})
        await notify("textDocument/didOpen", {"textDocument": {"uri": uri, "languageId": lang, "version": 1, "text": text}})
        await notify("textDocument/didSave", {"textDocument": {"uri": uri}, "text": text})

        try:
            got = await asyncio.wait_for(asyncio.shield(diags), a.timeout)
        except (TimeoutError, RuntimeError) as e:
            got = None
            print("diagnostics: none received", f"({e})" if str(e) else "")
        if got is not None:
            print(f"diagnostics: {len(got)}")
            for d in got[:8]:
                r = d["range"]["start"]
                print(f"  [{d.get('severity')}] {r['line']+1}:{r['character']+1} {d['message'].splitlines()[0][:110]}")
        if a.expect_error and not any(d.get("severity", 1) == 1 for d in (got or [])):
            print("FAIL: expected an error diagnostic")
            ok = False

        pos = {"textDocument": {"uri": uri}, "position": {"line": a.line, "character": a.col}}
        if caps.get("completionProvider") is not None:
            res = (await request("textDocument/completion", pos)).get("result")
            items = res.get("items", []) if isinstance(res, dict) else (res or [])
            labels = [i["label"].strip() for i in items]
            print(f"completion: {len(labels)} items, e.g. {labels[:12]}")
            if a.expect_completion and not any(l == a.expect_completion or l.startswith(a.expect_completion + "(") for l in labels):
                print(f"FAIL: expected completion {a.expect_completion!r}")
                ok = False
        else:
            print("completion: not supported")
            ok = ok and not a.expect_completion
        if caps.get("hoverProvider"):
            res = (await request("textDocument/hover", pos)).get("result")
            contents = (res or {}).get("contents") if res else None
            if isinstance(contents, dict):
                contents = contents.get("value")
            elif isinstance(contents, list):
                contents = " ".join(c if isinstance(c, str) else c.get("value", "") for c in contents)
            print("hover:", (contents or "").strip().splitlines()[:1])
        rt.cancel()
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
