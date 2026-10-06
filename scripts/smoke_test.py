"""End-to-end smoke test through nginx.

    python3 scripts/smoke_test.py [base_url] [template ...]

Registers a throwaway user, then for each template: creates a repl, starts
its container, presses Run over the console websocket, prints the output, and
reports listening ports. Needs `aiohttp`.
"""
import asyncio
import json
import secrets
import sys

import aiohttp

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8380"
TEMPLATES = sys.argv[2:] or ["python", "nodejs", "c", "flask"]


async def run_template(s: aiohttp.ClientSession, slug: str) -> bool:
    r = await s.post(f"{BASE}/api/v1/repls", json={"name": f"smoke-{slug}", "template": slug})
    if r.status >= 300:
        print(f"[{slug}] create failed {r.status}: {await r.text()}")
        return False
    repl = await r.json()
    rid = repl["id"]
    r = await s.post(f"{BASE}/api/v1/repls/{rid}/start")
    print(f"[{slug}] repl {rid} start -> {r.status}")
    ws_url = BASE.replace("http", "ws", 1) + f"/ws/repls/{rid}/run"
    out, ok = [], False
    async with s.ws_connect(ws_url) as ws:
        await ws.send_str(json.dumps({"type": "resize", "cols": 100, "rows": 30}))
        await ws.send_str(json.dumps({"type": "start"}))
        try:
            async with asyncio.timeout(90):
                async for msg in ws:
                    m = json.loads(msg.data)
                    if m["type"] == "output":
                        out.append(m["data"])
                    elif m["type"] == "status" and not m["running"] and m.get("exitCode") is not None:
                        ok = m["exitCode"] == 0
                        break
                    if repl.get("config", {}).get("port") and "".join(out).strip():
                        await asyncio.sleep(8)
                        ports = await (await s.get(f"{BASE}/api/v1/repls/{rid}/ports")).json()
                        print(f"[{slug}] ports: {ports}")
                        ok = bool(ports.get("ports"))
                        break
        except TimeoutError:
            print(f"[{slug}] timeout")
    text = "".join(out)
    print(f"[{slug}] {'OK' if ok else 'FAIL'} output tail: {text[-300:]!r}")
    await s.post(f"{BASE}/api/v1/repls/{rid}/stop")
    return ok


async def main() -> None:
    async with aiohttp.ClientSession(cookie_jar=aiohttp.CookieJar(unsafe=True)) as s:
        name = "smoke" + secrets.token_hex(3)
        r = await s.post(f"{BASE}/api/v1/auth/register",
                         json={"email": f"{name}@example.com", "username": name, "password": "password123"})
        print("register", r.status)
        results = {t: await run_template(s, t) for t in TEMPLATES}
        print(json.dumps(results, indent=1))
        sys.exit(0 if all(results.values()) else 1)


asyncio.run(main())
