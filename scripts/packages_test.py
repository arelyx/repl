"""End-to-end test of package management, through nginx.

    python3 scripts/packages_test.py [base_url] [case ...]

For each case: creates a repl from a template, starts it, then either installs
a package from the Packages panel's websocket (`add`) or relies on Run to
install what the code imports (`guess`). It writes code that uses the package,
presses Run and checks the output. The `persist` cases then stop and start
the container and run again, which must work without installing anything.
Needs `aiohttp`.
"""
import asyncio
import json
import re
import secrets
import sys
import time

import aiohttp

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8380"
ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")

# name: (template, mode, manager, package, {file: code}, expected output, search query)
CASES = {
    "python-add": ("python", "add", "python", "humanize",
                   {"main.py": "import humanize\nprint(humanize.intcomma(1234567))\n"}, "1,234,567", "humaniz"),
    "python-guess": ("python", "guess", "python", "emoji",
                     {"main.py": "import emoji\nprint(emoji.emojize('ok :thumbs_up:'))\n"}, "ok 👍", None),
    "node-add": ("nodejs", "add", "node", "lodash",
                 {"index.js": "const _ = require('lodash');\nconsole.log(_.chunk([1, 2, 3, 4], 2).length);\n"}, "2", "lodash"),
    "node-guess": ("nodejs", "guess", "node", "ms",
                   {"index.js": "const ms = require('ms');\nconsole.log(ms('2h'));\n"}, "7200000", None),
    "rust-add": ("rust", "add", "rust", "itoa",
                 {"src/main.rs": "fn main() {\n    let mut b = itoa::Buffer::new();\n    println!(\"{}\", b.format(128u64));\n}\n"},
                 "128", "itoa"),
    "go-add": ("go", "add", "go", "github.com/google/uuid",
               {"main.go": "package main\n\nimport (\n\t\"fmt\"\n\n\t\"github.com/google/uuid\"\n)\n\nfunc main() {\n\tfmt.Println(len(uuid.NewString()))\n}\n"},
               "36", "uuid"),
    "go-guess": ("go", "guess", "go", "github.com/google/uuid",
                 {"main.go": "package main\n\nimport (\n\t\"fmt\"\n\n\t\"github.com/google/uuid\"\n)\n\nfunc main() {\n\tfmt.Println(len(uuid.NewString()))\n}\n"},
                 "36", None),
    "ruby-add": ("ruby", "add", "ruby", "chronic",
                 {"main.rb": "require 'chronic'\nputs Chronic.parse('tomorrow').class\n"}, "Time", "chronic"),
    "php-add": ("php-cli", "add", "php", "ramsey/uuid",
                {"main.php": "<?php\nrequire __DIR__ . '/vendor/autoload.php';\necho strlen(Ramsey\\Uuid\\Uuid::uuid4()->toString()), \"\\n\";\n"},
                "36", "ramsey/uuid"),
    "java-add": ("java", "add", "jvm", "com.google.code.gson:gson",
                 {"Main.java": "public class Main {\n    public static void main(String[] args) {\n        System.out.println(new com.google.gson.Gson().toJson(java.util.List.of(1, 2)));\n    }\n}\n"},
                 "[1,2]", "gson"),
    "kotlin-add": ("kotlin", "add", "jvm", "com.google.code.gson:gson",
                   {"main.kt": "fun main() {\n    println(com.google.gson.Gson().toJson(listOf(1, 2)))\n}\n"}, "[1,2]", None),
    "csharp-add": ("csharp", "add", "dotnet", "Humanizer.Core",
                   {"Program.cs": "using Humanizer;\nConsole.WriteLine(3.ToWords());\n"}, "three", "humanizer"),
    "r-guess": ("r", "guess", "r", "praise",
                {"main.r": "library(praise)\ncat(nchar(praise()) > 0, \"\\n\")\n"}, "TRUE", "praise"),
    "perl-add": ("perl", "add", "perl", "JSON::Tiny",
                 {"main.pl": "use strict;\nuse JSON::Tiny qw(encode_json);\nprint encode_json([1, 2]), \"\\n\";\n"}, "[1,2]", "JSON::Tiny"),
    "lua-add": ("lua", "add", "lua", "inspect",
                {"main.lua": "local inspect = require('inspect')\nprint(inspect({1, 2}))\n"}, "{ 1, 2 }", "inspect"),
    "haskell-add": ("haskell", "add", "haskell", "split",
                    {"main.hs": "import Data.List.Split\nmain = print (splitOn \",\" \"a,b,c\")\n"}, "[\"a\",\"b\",\"c\"]", "split"),
}
PERSIST = {"python-add", "node-add", "go-add", "java-add", "haskell-add"}


class Repl:
    def __init__(self, s, rid):
        self.s, self.id = s, rid
        self.ws_base = BASE.replace("http", "ws", 1) + f"/ws/repls/{rid}"

    async def write(self, path, content):
        r = await self.s.put(f"{BASE}/api/v1/repls/{self.id}/files/content", json={"path": path, "content": content})
        assert r.status < 300, f"write {path}: {r.status} {await r.text()}"

    async def read(self, path):
        r = await self.s.get(f"{BASE}/api/v1/repls/{self.id}/files/content", params={"path": path})
        return (await r.json()).get("content", "") if r.status == 200 else None

    async def start(self):
        r = await self.s.post(f"{BASE}/api/v1/repls/{self.id}/start")
        assert r.status < 300, f"start: {r.status} {await r.text()}"

    async def stop(self):
        await self.s.post(f"{BASE}/api/v1/repls/{self.id}/stop")

    async def run(self, timeout=900):
        out = []
        async with self.s.ws_connect(f"{self.ws_base}/run") as ws:
            await ws.send_str(json.dumps({"type": "resize", "cols": 120, "rows": 40}))
            await ws.send_str(json.dumps({"type": "start"}))
            started = False
            async with asyncio.timeout(timeout):
                async for msg in ws:
                    m = json.loads(msg.data)
                    if m["type"] == "output":
                        out.append(m["data"])
                    elif m["type"] == "status":
                        if m["running"]:
                            started = True
                        elif started and m.get("exitCode") is not None:
                            return m["exitCode"], ANSI.sub("", "".join(out))
        return None, ANSI.sub("", "".join(out))

    async def pkg(self, messages, until):
        """Send messages on /pkg; collect replies until `until(reply)` is true."""
        replies = []
        async with self.s.ws_connect(f"{self.ws_base}/pkg") as ws:
            for m in messages:
                await ws.send_str(json.dumps(m))
            async with asyncio.timeout(1200):
                async for msg in ws:
                    m = json.loads(msg.data)
                    replies.append(m)
                    if until(m):
                        return replies
        return replies


async def run_case(s, name):
    template, mode, manager, package, files, expected, query = CASES[name]
    t0 = time.monotonic()
    r = await s.post(f"{BASE}/api/v1/repls", json={"name": f"pkg-{name}", "template": template})
    if r.status >= 300:
        print(f"[{name}] create failed {r.status}: {await r.text()}")
        return False
    repl = Repl(s, (await r.json())["id"])
    ok = True
    try:
        await repl.start()
        for path, code in files.items():
            await repl.write(path, code)
        if query:
            res = await repl.pkg([{"type": "search", "id": 1, "manager": manager, "query": query}],
                                 lambda m: m["type"] == "results")
            items = res[-1].get("items", [])
            hit = any(i["name"].lower() == package.lower() for i in items)
            print(f"[{name}] search {query!r}: {len(items)} results, {package} {'found' if hit else 'MISSING'}"
                  + (f" ({res[-1]['error']})" if res[-1].get("error") else ""))
            ok &= hit
        if mode == "add":
            res = await repl.pkg([{"type": "add", "manager": manager, "name": package}], lambda m: m["type"] == "done")
            log = ANSI.sub("", "".join(m.get("data", "") for m in res if m["type"] == "log"))
            if not res[-1].get("ok"):
                print(f"[{name}] add FAILED:\n{log[-1500:]}")
                return False
            info = await repl.pkg([{"type": "info"}], lambda m: m["type"] == "info")
            mgr = next((m for m in info[-1]["managers"] if m["id"] == manager), None)
            listed = mgr and any(p["name"].lower() == package.lower() for p in mgr["packages"])
            print(f"[{name}] added {package}; listed: {bool(listed)}")
            ok &= bool(listed)
        code, out = await repl.run()
        got = expected in out
        print(f"[{name}] run exit {code}, expected {'present' if got else 'MISSING'}: {out.strip()[-400:]!r}")
        ok &= got and code == 0
        if mode == "guess":
            info = await repl.pkg([{"type": "info"}], lambda m: m["type"] == "info")
            mgr = next((m for m in info[-1]["managers"] if m["id"] == manager), None)
            listed = mgr and any(p["name"].lower() == package.lower() for p in mgr["packages"])
            print(f"[{name}] guessed {package} listed: {bool(listed)}")
            ok &= bool(listed)
        if name in PERSIST:
            await repl.stop()
            await repl.start()
            code, out = await repl.run()
            reinstalled = "Installing" in out or "Downloading" in out
            got = expected in out
            print(f"[{name}] after restart: exit {code}, expected {'present' if got else 'MISSING'}, "
                  f"{'REINSTALLED' if reinstalled else 'no reinstall'}")
            ok &= got and code == 0 and not reinstalled
        if mode == "add":
            res = await repl.pkg([{"type": "remove", "manager": manager, "name": package}], lambda m: m["type"] == "done")
            info = [m for m in res if m["type"] == "info"]
            print(f"[{name}] remove ok: {res[-1].get('ok')}")
            ok &= bool(res[-1].get("ok"))
    except (AssertionError, TimeoutError) as e:
        print(f"[{name}] ERROR {e!r}")
        ok = False
    finally:
        await repl.stop()
        await s.delete(f"{BASE}/api/v1/repls/{repl.id}")
    print(f"[{name}] {'OK' if ok else 'FAIL'} in {time.monotonic() - t0:.0f}s")
    return ok


async def main():
    names = sys.argv[2:] or list(CASES)
    async with aiohttp.ClientSession(cookie_jar=aiohttp.CookieJar(unsafe=True)) as s:
        user = "pkg" + secrets.token_hex(3)
        r = await s.post(f"{BASE}/api/v1/auth/register",
                         json={"email": f"{user}@example.com", "username": user, "password": "password123"})
        print("register", r.status)
        results = {}
        for n in names:
            results[n] = await run_case(s, n)
        print(json.dumps(results, indent=1))
        sys.exit(0 if all(results.values()) else 1)


if __name__ == "__main__":
    asyncio.run(main())
