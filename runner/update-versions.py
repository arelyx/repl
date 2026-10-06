#!/usr/bin/env python3
"""Bump the toolchain pins in runner/Dockerfile to the latest stable releases.

    python3 runner/update-versions.py          # rewrite the Dockerfile
    python3 runner/update-versions.py --check  # report only; exit 1 if stale

Each version comes from the project's own release feed (or endoflife.date,
which tracks them). A source that can't be reached keeps its current pin
and is reported, so a flaky mirror never produces a broken Dockerfile.
Rebuild afterwards with `make runner`; the build runs `replot-versions`,
which fails if any toolchain doesn't start.
"""
import json
import re
import sys
import urllib.request
from pathlib import Path

DOCKERFILE = Path(__file__).with_name("Dockerfile")
UA = {"User-Agent": "replot-update-versions"}


def get(url: str) -> str:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read().decode()


def getj(url: str):
    return json.loads(get(url))


def eol_latest(product: str) -> str:
    """Latest patch of the newest release cycle on endoflife.date."""
    releases = getj(f"https://endoflife.date/api/v1/products/{product}/")["result"]["releases"]
    return releases[0]["latest"]["name"]


def vkey(v: str):
    return [int(x) for x in re.findall(r"\d+", v)]


def latest_listing(url: str, pattern: str) -> str:
    """Highest version matched by `pattern` (one group) in a directory listing."""
    found = set(re.findall(pattern, get(url)))
    return max(found, key=vkey)


def node() -> str:
    return getj("https://nodejs.org/dist/index.json")[0]["version"].lstrip("v")


def go() -> str:
    return get("https://go.dev/VERSION?m=text").splitlines()[0].removeprefix("go")


def java() -> str:
    feature = getj("https://api.adoptium.net/v3/info/available_releases")["most_recent_feature_release"]
    assets = getj(f"https://api.adoptium.net/v3/assets/latest/{feature}/hotspot"
                  "?architecture=x64&image_type=jdk&os=linux")
    return assets[0]["release_name"]


def dotnet() -> str:
    for rel in getj("https://builds.dotnet.microsoft.com/dotnet/release-metadata/releases-index.json")["releases-index"]:
        if rel["support-phase"] in ("active", "maintenance"):
            return rel["latest-sdk"]
    raise RuntimeError("no supported .NET channel")


def github_latest(repo: str) -> str:
    return getj(f"https://api.github.com/repos/{repo}/releases/latest")["tag_name"]


def gcc() -> str:
    # Docker Hub tags of the official gcc image, e.g. "16.2".
    tags = getj("https://hub.docker.com/v2/repositories/library/gcc/tags?page_size=100")["results"]
    return max((t["name"] for t in tags if re.fullmatch(r"\d+\.\d+", t["name"])), key=vkey)


SOURCES = {
    "GCC_VERSION": gcc,
    "LLVM_VERSION": lambda: github_latest("llvm/llvm-project").removeprefix("llvmorg-").split(".")[0],
    "PYTHON_VERSION": lambda: eol_latest("python"),
    "NODE_VERSION": node,
    "GO_VERSION": go,
    "RUST_VERSION": lambda: eol_latest("rust"),
    "JAVA_VERSION": java,
    "MAVEN_VERSION": lambda: eol_latest("apache-maven"),
    "KOTLIN_VERSION": lambda: github_latest("JetBrains/kotlin").lstrip("v"),
    "DOTNET_SDK_VERSION": dotnet,
    "RUBY_VERSION": lambda: eol_latest("ruby"),
    "PHP_VERSION": lambda: eol_latest("php"),
    "PERL_VERSION": lambda: eol_latest("perl"),
    "LUA_VERSION": lambda: eol_latest("lua"),
    "GHC_VERSION": lambda: eol_latest("ghc"),
    "SBCL_VERSION": lambda: latest_listing("https://www.sbcl.org/platform-table.html", r"sbcl-(\d+\.\d+\.\d+)-x86-64-linux"),
    "NASM_VERSION": lambda: latest_listing("https://www.nasm.us/pub/nasm/releasebuilds/", r'href="(\d+\.\d+(?:\.\d+)?)/"'),
}


def main() -> int:
    check = "--check" in sys.argv
    text = DOCKERFILE.read_text()
    stale = errors = 0
    for arg, source in SOURCES.items():
        m = re.search(rf"^ARG {arg}=(\S+)$", text, re.M)
        if not m:
            print(f"{arg:20} not pinned in Dockerfile")
            errors += 1
            continue
        current = m.group(1)
        try:
            latest = source()
        except Exception as e:  # keep the current pin
            print(f"{arg:20} {current:14} (lookup failed: {e})")
            errors += 1
            continue
        if latest == current:
            print(f"{arg:20} {current:14} up to date")
            continue
        stale += 1
        print(f"{arg:20} {current:14} -> {latest}")
        text = text[: m.start(1)] + latest + text[m.end(1):]
    if not check and stale:
        DOCKERFILE.write_text(text)
        print(f"\nUpdated {stale} pin(s) in {DOCKERFILE}. Rebuild with `make runner`.")
    return 1 if (check and stale) else 0


if __name__ == "__main__":
    sys.exit(main())
