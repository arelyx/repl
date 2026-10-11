#!/usr/bin/env python3
"""Repl's package manager: one interface over each language's own tool.

The container is deleted when a repl stops and only the project directory is
kept, so everything a repl installs lives under .repl/ in the project. The
image points each tool there (runner/Dockerfile):

  .repl/python    a venv over the image's Python (its packages stay visible)
  .repl/cargo, go, gems, composer, perl, lua, R, cabal, npm   installed state
  .repl/cache/    downloads (uv, Maven, Gradle, NuGet, Composer); not backed up
  .repl/state.json  what `sync` last did

Usage, inside the repl as its user:
  packager.py ensure                     create .repl/ (container start)
  packager.py sync                       before Run: install what the manifests
                                         declare, then what the code imports
  packager.py info                       JSON: managers and their packages
  packager.py add MANAGER NAME [VERSION]
  packager.py remove MANAGER NAME
  packager.py search MANAGER QUERY       JSON results

Standard library only: it runs on the image's Python, outside the venv.
"""
import ast
import fcntl
import glob
import hashlib
import html
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager

APP = "/home/runner/app"
PKG = os.path.join(APP, ".repl")
VENV = os.path.join(PKG, "python")
VENV_PY = os.path.join(VENV, "bin", "python")
STATE_FILE = os.path.join(PKG, "state.json")
LOCK_FILE = os.path.join(PKG, "lock")
BASE_PYTHON = "/opt/python/current/bin/python3"
NODE_BUILTINS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "node-builtins.json")
UA = "repl-packager/1.0 (+https://github.com/arelyx/repl)"

# Not scanned for imports: dependencies, build output, environments.
SKIP_DIRS = {
    "node_modules", "__pycache__", "target", "dist", "build", "vendor", "venv", "env",
    "obj", "bin", "out", "site-packages", "_build", "dist-newstyle",
}
MAX_SCAN_FILES = 3000
MAX_SCAN_BYTES = 512 * 1024

DIM, RED, RESET = "\x1b[2m", "\x1b[31m", "\x1b[0m"

# npm's spinner is left behind in the console when the program starts.
os.environ.setdefault("npm_config_progress", "false")

# Names go to the tools as single argv entries, never through a shell; these
# only keep option-looking or malformed input away from them.
NAME_RE = re.compile(r"^[A-Za-z0-9@_][A-Za-z0-9@._/:+~-]{0,213}$")
VERSION_RE = re.compile(r"^[A-Za-z0-9.*+!<>=~^_,| -]{1,100}$")


class Fail(Exception):
    pass


def say(msg):
    print(f"{DIM}{msg}{RESET}", flush=True)


def run(argv, check=True, env=None):
    say("$ " + " ".join(shlex.quote(a) for a in argv))
    try:
        code = subprocess.run(argv, cwd=APP, env=env).returncode
    except FileNotFoundError:
        raise Fail(f"{argv[0]} is not installed in this image")
    if check and code != 0:
        raise Fail(f"{os.path.basename(argv[0])} exited with status {code}")
    return code


def capture(argv, timeout=60):
    """stdout of a quiet helper command, or None if it failed."""
    try:
        p = subprocess.run(argv, cwd=APP, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return p.stdout if p.returncode == 0 else None


def p(*parts):
    return os.path.join(APP, *parts)


def exists(*parts):
    return os.path.exists(p(*parts))


def read(path):
    with open(path if os.path.isabs(path) else p(path), encoding="utf-8", errors="replace") as f:
        return f.read()


def read_or(path, default=""):
    try:
        return read(path)
    except OSError:
        return default


def write(path, text):
    """Replace a file atomically, keeping its mode."""
    full = path if os.path.isabs(path) else p(path)
    tmp = f"{full}.repl-tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    try:
        os.chmod(tmp, os.stat(full).st_mode & 0o7777)
    except OSError:
        pass
    os.replace(tmp, full)


def digest(*names):
    h = hashlib.sha256()
    for n in names:
        h.update(n.encode() + b"\0")
        try:
            with open(p(n), "rb") as f:
                h.update(f.read())
        except OSError:
            h.update(b"<missing>")
    return h.hexdigest()[:24]


def digest_of(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()[:24]


# ---------------------------------------------------------------- HTTP

def fetch(url, accept="application/json", timeout=10):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(8 * 1024 * 1024).decode("utf-8", "replace")


def fetch_json(url, timeout=10):
    return json.loads(fetch(url, timeout=timeout))


def q(s):
    return urllib.parse.quote(s, safe="")


def exists_url(url):
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status == 200
    except urllib.error.HTTPError:
        return False


# ---------------------------------------------------------------- project

def replit_cfg():
    try:
        return tomllib.loads(read(".replit"))
    except (OSError, tomllib.TOMLDecodeError):
        return {}


def packager_cfg():
    """[packager] in .replit: guessImports = false turns off installing what
    the code imports; ignoredPackages lists names never to install."""
    cfg = replit_cfg()
    pk = cfg.get("packager") if isinstance(cfg.get("packager"), dict) else {}
    feats = pk.get("features") if isinstance(pk.get("features"), dict) else {}
    guess = pk.get("guessImports", feats.get("guessImports", True))
    ignored = pk.get("ignoredPackages", [])
    return {
        "language": str(cfg.get("language", "")).lower(),
        "guess": guess is not False,
        "ignored": {str(x).lower() for x in ignored} if isinstance(ignored, list) else set(),
    }


_files = None


def project_files():
    global _files
    if _files is None:
        _files = []
        for root, dirs, files in os.walk(APP):
            dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS and not d.startswith("."))
            rel = os.path.relpath(root, APP)
            for f in sorted(files):
                _files.append(f if rel == "." else os.path.join(rel, f))
            if len(_files) >= MAX_SCAN_FILES:
                break
    return _files


def files_with(*exts):
    return [f for f in project_files() if f.endswith(exts)]


def source(rel):
    try:
        if os.path.getsize(p(rel)) > MAX_SCAN_BYTES:
            return ""
        return read(rel)
    except OSError:
        return ""


# ---------------------------------------------------------------- state

def load_state():
    try:
        with open(STATE_FILE) as f:
            s = json.load(f)
            return s if isinstance(s, dict) else {}
    except (OSError, ValueError):
        return {}


def save_state(state):
    try:
        os.makedirs(PKG, exist_ok=True)
        write(STATE_FILE, json.dumps(state, indent=1, sort_keys=True))
    except OSError:
        pass


@contextmanager
def locked():
    """One package operation at a time (Run's sync and the Packages panel)."""
    os.makedirs(PKG, exist_ok=True)
    fd = os.open(LOCK_FILE, os.O_RDWR | os.O_CREAT, 0o644)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            say("Waiting for another package operation to finish…")
            fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


# ---------------------------------------------------------------- .repl/

PIP_SHIM = f"""#!/bin/sh
# pip for this repl's environment. pip itself comes from the image's Python;
# run from the venv's interpreter it installs into the venv.
exec {VENV_PY} -m pip "$@"
"""


def venv_ok():
    try:
        cfg = read(os.path.join(VENV, "pyvenv.cfg"))
    except OSError:
        return False
    m = re.search(r"^version\s*=\s*(\d+)\.(\d+)", cfg, re.M)
    if not m or (int(m.group(1)), int(m.group(2))) != tuple(sys.version_info[:2]):
        return False  # a new Python minor: its site-packages layout differs
    return os.path.exists(VENV_PY) and os.path.exists(os.path.join(VENV, "bin", "pip"))


def ensure():
    os.makedirs(os.path.join(PKG, "cache"), exist_ok=True)
    # R ignores an R_LIBS_USER that doesn't exist.
    os.makedirs(os.path.join(PKG, "R"), exist_ok=True)
    gi = os.path.join(PKG, ".gitignore")
    if not os.path.exists(gi):
        with open(gi, "w") as f:
            f.write("# Installed packages and download caches, managed by Repl.\n*\n")
    if venv_ok():
        return
    if os.path.lexists(VENV):
        shutil.rmtree(VENV, ignore_errors=True)
    # No pip of its own: the shim runs the image's pip, which is faster to
    # create and is upgraded with the image.
    subprocess.run([BASE_PYTHON, "-m", "venv", "--without-pip", "--system-site-packages", VENV],
                   check=True, cwd=APP)
    minor = "%d.%d" % sys.version_info[:2]
    for name in ("pip", "pip3", f"pip{minor}"):
        shim = os.path.join(VENV, "bin", name)
        with open(shim, "w") as f:
            f.write(PIP_SHIM)
        os.chmod(shim, 0o755)
    state = load_state()
    state.get("sync", {}).pop("python", None)
    state.pop("python_guess", None)
    save_state(state)


# ---------------------------------------------------------------- managers

class Manager:
    id = label = tool = registry = ""
    languages = ()      # .replit `language` values this manager serves
    extensions = ()     # source files that suggest it
    manifests = ()      # files that settle it
    name_hint = "package name"
    versioned = True    # accepts a version on add

    def has_manifest(self):
        return any(exists(m) for m in self.manifests)

    def primary(self, lang):
        return lang in self.languages or self.has_manifest()

    def detected(self, lang):
        return self.primary(lang) or bool(self.extensions and files_with(*self.extensions))

    def manifest(self):
        for m in self.manifests:
            if exists(m):
                return m
        return self.manifests[0] if self.manifests else None

    def note(self):
        return None

    def packages(self):
        return []

    def add(self, name, version):
        raise Fail("not supported")

    def remove(self, name):
        raise Fail("not supported")

    def sync(self, state, cfg):
        pass

    def search(self, query):
        return []

    def describe(self):
        return {
            "id": self.id, "label": self.label, "tool": self.tool, "registry": self.registry,
            "manifest": self.manifest(), "nameHint": self.name_hint, "versioned": self.versioned,
            "note": self.note(), "packages": self.packages(),
        }


def synced(state, key, value):
    return state.setdefault("sync", {}).get(key) == value


def mark_synced(state, key, value):
    state.setdefault("sync", {})[key] = value


def install_batch(names, install_one, failed, published):
    """Install guessed packages together, then one by one if that fails, so
    one wrong guess doesn't block the rest. Returns those that installed.

    A name the registry doesn't have goes into `failed` and isn't guessed
    again; any other failure (network, disk) is retried on the next Run."""
    try:
        install_one(names)
        return list(names)
    except Fail:
        pass
    ok = []
    for n in names:
        try:
            if len(names) > 1:
                install_one([n])
                ok.append(n)
                continue
        except Fail:
            pass
        if published(n) is False:
            failed.add(n)
    return ok


def registry_has(url):
    """True/False if the registry answered, None if it couldn't be asked."""
    req = urllib.request.Request(url, method="GET", headers={"User-Agent": UA, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10):
            return True
    except urllib.error.HTTPError as e:
        return False if e.code == 404 else None
    except (urllib.error.URLError, TimeoutError, OSError):
        return None


# ---- Python

def norm_py(name):
    return re.sub(r"[-_.]+", "-", name).lower()


REQ_RE = re.compile(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*([^#]*?)\s*(?:#.*)?$")

# Import names whose PyPI distribution is called something else.
PY_DIST = {
    "PIL": "pillow", "cv2": "opencv-python", "sklearn": "scikit-learn", "skimage": "scikit-image",
    "yaml": "pyyaml", "bs4": "beautifulsoup4", "dateutil": "python-dateutil", "dotenv": "python-dotenv",
    "jwt": "pyjwt", "Crypto": "pycryptodome", "Cryptodome": "pycryptodomex", "OpenSSL": "pyopenssl",
    "serial": "pyserial", "usb": "pyusb", "gi": "pygobject", "magic": "python-magic",
    "docx": "python-docx", "pptx": "python-pptx", "telegram": "python-telegram-bot",
    "discord": "discord.py", "googleapiclient": "google-api-python-client", "attr": "attrs",
    "MySQLdb": "mysqlclient", "psycopg2": "psycopg2-binary", "mpl_toolkits": "matplotlib",
    "wx": "wxpython", "zmq": "pyzmq", "fitz": "pymupdf", "Levenshtein": "levenshtein",
    "slugify": "python-slugify", "multipart": "python-multipart", "jose": "python-jose",
    "socketio": "python-socketio", "engineio": "python-engineio", "pkg_resources": "setuptools",
    "dns": "dnspython", "nacl": "pynacl", "git": "gitpython", "github": "pygithub",
    "faiss": "faiss-cpu", "umap": "umap-learn", "ldap": "python-ldap", "kafka": "kafka-python",
    "OpenGL": "pyopengl", "pyaudio": "pyaudio", "speech_recognition": "speechrecognition",
    "websocket": "websocket-client", "Bio": "biopython", "rest_framework": "djangorestframework",
    "corsheaders": "django-cors-headers", "IPython": "ipython", "pygame": "pygame-ce",
    "ruamel": "ruamel.yaml", "markdown_it": "markdown-it-py", "lxml": "lxml", "win32api": "",
    "sentence_transformers": "sentence-transformers", "tensorflow_hub": "tensorflow-hub",
    "google": "", "azure": "", "pywintypes": "", "win32con": "", "_winapi": "",
}

PY_LIST_SCRIPT = r"""
import importlib.metadata as md, json, re, sys
prefix = sys.prefix + "/"
dists, required = {}, set()
for d in md.distributions():
    name = d.metadata["Name"]
    if not name:
        continue
    key = re.sub(r"[-_.]+", "-", name).lower()
    if key in dists:
        continue
    dists[key] = [name, d.version, str(d.locate_file("")).startswith(prefix)]
    for r in d.requires or []:
        if "extra ==" not in r:
            m = re.match(r"\s*([A-Za-z0-9][A-Za-z0-9._-]*)", r)
            if m:
                required.add(re.sub(r"[-_.]+", "-", m.group(1)).lower())
print(json.dumps({"dists": dists, "required": sorted(required)}))
"""

PY_MISSING_SCRIPT = r"""
import importlib.util, json, sys
sys.path.insert(0, "")
out = []
for n in json.loads(sys.argv[1]):
    try:
        if importlib.util.find_spec(n) is None:
            out.append(n)
    except (ImportError, ValueError):
        out.append(n)
print(json.dumps(out))
"""


def _catches_import_error(handler):
    t = handler.type
    if t is None:
        return True
    names = t.elts if isinstance(t, ast.Tuple) else [t]
    return any(isinstance(n, ast.Name) and n.id in ("ImportError", "ModuleNotFoundError", "Exception")
               for n in names)


def py_imports(paths):
    """Top-level names imported by these files, leaving out optional imports
    (inside try/except ImportError)."""
    found = set()
    for rel in paths:
        try:
            tree = ast.parse(source(rel))
        except (SyntaxError, ValueError):
            continue
        optional = set()
        for node in ast.walk(tree):
            if isinstance(node, (ast.Try, getattr(ast, "TryStar", ast.Try))) and any(
                    _catches_import_error(h) for h in node.handlers):
                for stmt in node.body:
                    optional.update(id(n) for n in ast.walk(stmt))
        for node in ast.walk(tree):
            if id(node) in optional:
                continue
            if isinstance(node, ast.Import):
                found.update(a.name.split(".")[0] for a in node.names)
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                found.add(node.module.split(".")[0])
    return found


class Python(Manager):
    id, label, tool, registry = "python", "Python", "uv", "PyPI"
    languages = ("python", "python3")
    extensions = (".py",)
    manifests = ("pyproject.toml", "requirements.txt")

    def _pyproject_deps(self):
        try:
            data = tomllib.loads(read("pyproject.toml"))
        except (OSError, tomllib.TOMLDecodeError):
            return None
        proj = data.get("project")
        if not isinstance(proj, dict):
            return None
        deps = proj.get("dependencies", [])
        return [str(d) for d in deps] if isinstance(deps, list) else None

    def manifest(self):
        if self._pyproject_deps() is not None and not exists("requirements.txt"):
            return "pyproject.toml"
        return "requirements.txt"

    def requirements(self):
        """[(name, extras, spec, raw)] declared by the manifest."""
        if self.manifest() == "pyproject.toml":
            lines = self._pyproject_deps() or []
        else:
            lines = [ln for ln in read_or("requirements.txt").splitlines()
                     if ln.strip() and not ln.strip().startswith(("#", "-"))]
        out = []
        for ln in lines:
            m = REQ_RE.match(ln)
            if m:
                out.append((m.group(1), m.group(2) or "", m.group(3).strip(), ln.strip()))
        return out

    def uv(self, *args):
        return ["uv", "pip", *args, "--python", VENV_PY]

    def _list(self):
        out = capture([VENV_PY, "-c", PY_LIST_SCRIPT])
        try:
            return json.loads(out) if out else {"dists": {}, "required": []}
        except ValueError:
            return {"dists": {}, "required": []}

    def packages(self):
        listing = self._list()
        dists, required = listing["dists"], set(listing["required"])
        rows, seen = [], set()
        for name, _extras, spec, _raw in self.requirements():
            key = norm_py(name)
            seen.add(key)
            d = dists.get(key)
            rows.append({"name": name, "spec": spec, "version": d[1] if d else None, "declared": True})
        # Installed into the project by hand (pip in the shell), not as a dependency.
        for key, (name, version, in_project) in sorted(dists.items()):
            if in_project and key not in seen and key not in required and key not in ("pip", "setuptools", "wheel"):
                rows.append({"name": name, "spec": "", "version": version, "declared": False})
        return rows

    def _installed_version(self, name):
        d = self._list()["dists"].get(norm_py(name))
        return (d[0], d[1]) if d else (name, None)

    def add(self, name, version):
        run(self.uv("install", f"{name}=={version}" if version else name))
        real, ver = self._installed_version(name)
        self._record(real, f"=={ver}" if ver else "")

    def remove(self, name):
        key = norm_py(name)
        declared = any(norm_py(n) == key for n, *_ in self.requirements())
        d = self._list()["dists"].get(key)
        if d and d[2]:
            run(self.uv("uninstall", name))
        elif not declared:
            raise Fail(f"{name} isn't installed in this repl")
        if declared:
            self._unrecord(name)

    # Manifest edits keep the file as the user wrote it, line for line.

    def _record(self, name, spec):
        line = f"{name}{spec}"
        key = norm_py(name)
        if self.manifest() == "pyproject.toml":
            self._pyproject_edit(key, line)
            return
        lines = read_or("requirements.txt").splitlines()
        for i, ln in enumerate(lines):
            m = REQ_RE.match(ln)
            if m and not ln.strip().startswith(("#", "-")) and norm_py(m.group(1)) == key:
                lines[i] = f"{m.group(1)}{m.group(2) or ''}{spec}"
                break
        else:
            lines.append(line)
        if not exists("requirements.txt"):
            open(p("requirements.txt"), "a").close()
        write("requirements.txt", "\n".join(lines) + "\n")

    def _unrecord(self, name):
        key = norm_py(name)
        if self.manifest() == "pyproject.toml":
            self._pyproject_edit(key, None)
            return
        lines = [ln for ln in read_or("requirements.txt").splitlines()
                 if not ((m := REQ_RE.match(ln)) and not ln.strip().startswith(("#", "-"))
                         and norm_py(m.group(1)) == key)]
        write("requirements.txt", "\n".join(lines) + ("\n" if lines else ""))

    def _pyproject_edit(self, key, line):
        """Replace, add (line) or drop (None) one entry of [project].dependencies."""
        text = read("pyproject.toml")
        sec = re.search(r"^\[project\]\s*$", text, re.M)
        if not sec:
            raise Fail("pyproject.toml has no [project] table")
        end = re.search(r"^\[", text[sec.end():], re.M)
        body_end = sec.end() + (end.start() if end else len(text) - sec.end())
        body = text[sec.end():body_end]
        m = re.search(r"^dependencies\s*=\s*\[(.*?)\]", body, re.M | re.S)
        if not m:
            if line is None:
                return
            body = f"\ndependencies = [\n    {json.dumps(line)},\n]" + body
        else:
            items = re.findall(r"""("(?:[^"\\]|\\.)*"|'[^']*')""", m.group(1))
            entries = [tomllib.loads(f"x = {it}")["x"] for it in items]
            kept = [e for e in entries if not ((r := REQ_RE.match(e)) and norm_py(r.group(1)) == key)]
            if line is not None:
                kept.append(line)
            new = "dependencies = [\n" + "".join(f"    {json.dumps(e)},\n" for e in kept) + "]"
            body = body[:m.start()] + new + body[m.end():]
        write("pyproject.toml", text[:sec.end()] + body + text[body_end:])

    def _site_mtime(self):
        site = os.path.join(VENV, "lib", "python%d.%d" % sys.version_info[:2], "site-packages")
        try:
            return os.stat(site).st_mtime_ns
        except OSError:
            return 0

    def sync_key(self):
        # A recreated venv (new Python minor) needs everything installed again.
        return f"{digest(self.manifest())}:{os.stat(os.path.join(VENV, 'pyvenv.cfg')).st_mtime_ns}"

    def sync(self, state, cfg):
        reqs = self.requirements() if exists(self.manifest()) else []
        key = self.sync_key()
        if reqs and not synced(state, "python", key):
            say(f"Installing Python packages from {self.manifest()}…")
            if self.manifest() == "requirements.txt":
                run(self.uv("install", "-r", "requirements.txt"))
            else:
                run(self.uv("install", *[r[3] for r in reqs]))
        mark_synced(state, "python", key)
        if cfg["guess"] and self.primary(cfg["language"]):
            self._guess(state, cfg)
            # What the guess added to the manifest is installed already.
            mark_synced(state, "python", self.sync_key())

    def _guess(self, state, cfg):
        files = files_with(".py")
        if not files:
            return
        local = set()
        for f in files:
            parts = f[:-3].split(os.sep)
            local.update(parts)
        local.update(d for d in os.listdir(APP) if os.path.isdir(p(d)))
        declared = {norm_py(r[0]) for r in self.requirements()}
        cands = sorted(
            n for n in py_imports(files)
            if n not in sys.stdlib_module_names and n not in local and n != "__future__"
            and not n.startswith("_") and PY_DIST.get(n, n) and norm_py(PY_DIST.get(n, n)) not in declared
            and n.lower() not in cfg["ignored"] and norm_py(PY_DIST.get(n, n)) not in cfg["ignored"])
        key = digest_of([cands, self._site_mtime(), sorted(declared)])
        if not cands or state.get("python_guess") == key:
            return
        out = capture([VENV_PY, "-c", PY_MISSING_SCRIPT, json.dumps(cands)])
        missing = json.loads(out) if out else []
        failed = set(state.get("python_failed", []))
        todo = sorted({PY_DIST.get(n, n) for n in missing} - failed)
        if todo:
            say(f"Installing imported Python packages: {', '.join(todo)}")
            ok = install_batch(todo, lambda names: run(self.uv("install", *names)), failed,
                               lambda n: registry_has(f"https://pypi.org/simple/{q(norm_py(n))}/"))
            for name in ok:
                real, ver = self._installed_version(name)
                self._record(real, f"=={ver}" if ver else "")
            for name in sorted(set(todo) - set(ok)):
                say(f"Couldn't install {name}; add it in the Packages panel or ignore it in .replit")
            state["python_failed"] = sorted(failed)
        state["python_guess"] = digest_of([cands, self._site_mtime(), sorted(declared)])

    def search(self, query):
        return search_pypi(query)


# ---- Node.js

NPM_NAME = re.compile(r"^(?:@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*$")
JS_IMPORT = re.compile(
    r"""(?:\bimport\s+(?:[\w*{}\s,$]+?\s+from\s+)?|\bexport\s+[\w*{}\s,$]+?\s+from\s+|"""
    r"""\brequire\s*\(\s*|\bimport\s*\(\s*)['"]([^'"\n]+)['"]""")
JS_EXT = (".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx", ".vue", ".svelte")
DEP_SECTIONS = ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies")


def node_builtins():
    try:
        with open(NODE_BUILTINS_FILE) as f:
            return set(json.load(f))
    except (OSError, ValueError):
        return {"assert", "buffer", "child_process", "crypto", "events", "fs", "http", "https",
                "net", "os", "path", "process", "readline", "stream", "url", "util", "zlib"}


def npm_package_of(spec):
    if spec.startswith((".", "/", "#")) or ":" in spec:
        return None
    parts = spec.split("/")
    name = "/".join(parts[:2]) if spec.startswith("@") else parts[0]
    return name if NPM_NAME.match(name) else None


def js_path_aliases():
    """Import prefixes that tsconfig/jsconfig `paths` map to project files."""
    out = set()
    for cfg in ("tsconfig.json", "jsconfig.json"):
        text = re.sub(r"(?m)^\s*//.*$", "", read_or(cfg))
        for key in re.findall(r'"([^"]+)"\s*:\s*\[', text.split('"paths"', 1)[1] if '"paths"' in text else ""):
            out.add(key.rstrip("*").rstrip("/"))
    return out


class Node(Manager):
    id, label, tool, registry = "node", "Node.js", "npm", "npm"
    languages = ("javascript", "typescript", "nodejs", "node")
    extensions = JS_EXT
    manifests = ("package.json",)

    def _pkg(self):
        try:
            data = json.loads(read("package.json"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _declared(self):
        pkg = self._pkg()
        return {n for s in DEP_SECTIONS if isinstance(pkg.get(s), dict) for n in pkg[s]}

    def _installed(self, name):
        try:
            return json.loads(read(os.path.join("node_modules", name, "package.json"))).get("version")
        except (OSError, ValueError, AttributeError):
            return None

    def packages(self):
        pkg, rows = self._pkg(), []
        for section in ("dependencies", "devDependencies"):
            deps = pkg.get(section)
            if isinstance(deps, dict):
                for name, spec in sorted(deps.items()):
                    rows.append({"name": name, "spec": str(spec), "version": self._installed(name),
                                 "declared": True, "dev": section == "devDependencies"})
        return rows

    def _init(self):
        # Without a package.json here npm installs into the nearest parent
        # directory that has one (or node_modules), outside the project.
        if not self.has_manifest():
            name = re.sub(r"[^a-z0-9-]+", "-", os.environ.get("REPL_ID", "app").lower()).strip("-") or "app"
            pkg = {"name": name, "version": "1.0.0", "private": True}
            # Node warns about ES module syntax under a package.json without "type".
            srcs = [source(f) for f in files_with(".js", ".jsx")]
            if any(re.search(r"(?m)^\s*(?:import|export)\s", s) for s in srcs) and not any("require(" in s for s in srcs):
                pkg["type"] = "module"
            with open(p("package.json"), "w") as f:
                f.write(json.dumps(pkg, indent=2) + "\n")
            say("Created package.json")

    def add(self, name, version):
        self._init()
        run(["npm", "install", f"{name}@{version}" if version else name])

    def remove(self, name):
        run(["npm", "uninstall", name])

    def sync_key(self):
        return digest("package.json", "package-lock.json")

    def sync(self, state, cfg):
        if self.has_manifest():
            if self._declared() and (not synced(state, "node", self.sync_key()) or not exists("node_modules")):
                say("Installing Node.js packages from package.json…")
                run(["npm", "install"])
            mark_synced(state, "node", self.sync_key())
        if cfg["guess"] and self.primary(cfg["language"]):
            self._guess(state, cfg)

    def _guess(self, state, cfg):
        files = files_with(*JS_EXT)
        if not files:
            return
        names = set()
        for f in files:
            for m in JS_IMPORT.finditer(source(f)):
                n = npm_package_of(m.group(1))
                if n:
                    names.add(n)
        builtins, declared, aliases = node_builtins(), self._declared(), js_path_aliases()
        failed = set(state.get("node_failed", []))
        todo = sorted(
            n for n in names
            if n not in builtins and n not in declared and n not in failed and n not in cfg["ignored"]
            and not exists(n) and not exists("node_modules", n)
            and not any(a and (n == a or n.startswith(a + "/")) for a in aliases))
        if not todo:
            return
        say(f"Installing imported Node.js packages: {', '.join(todo)}")
        self._init()
        ok = install_batch(todo, lambda ns: run(["npm", "install", *ns]), failed,
                           lambda n: registry_has(f"https://registry.npmjs.org/{n.replace('/', '%2f')}"))
        for name in sorted(set(todo) - set(ok)):
            say(f"Couldn't install {name}; add it in the Packages panel or ignore it in .replit")
        state["node_failed"] = sorted(failed)
        mark_synced(state, "node", self.sync_key())

    def search(self, query):
        data = fetch_json(f"https://registry.npmjs.org/-/v1/search?text={q(query)}&size=20")
        return [{
            "name": o["package"]["name"], "version": o["package"].get("version"),
            "description": o["package"].get("description"),
            "downloads": (o.get("downloads") or {}).get("monthly"),
            "url": f"https://www.npmjs.com/package/{o['package']['name']}",
        } for o in data.get("objects", [])]


# ---- Rust

class Rust(Manager):
    id, label, tool, registry = "rust", "Rust", "cargo", "crates.io"
    languages = ("rust",)
    extensions = (".rs",)
    manifests = ("Cargo.toml",)

    def packages(self):
        try:
            data = tomllib.loads(read("Cargo.toml"))
        except (OSError, tomllib.TOMLDecodeError):
            return []
        try:
            lock = tomllib.loads(read("Cargo.lock"))
            locked_versions = {pk["name"]: pk["version"] for pk in lock.get("package", [])}
        except (OSError, tomllib.TOMLDecodeError, KeyError):
            locked_versions = {}
        rows = []
        for section in ("dependencies", "dev-dependencies", "build-dependencies"):
            for name, spec in sorted((data.get(section) or {}).items()):
                ver = spec if isinstance(spec, str) else (spec.get("version", "") if isinstance(spec, dict) else "")
                real = spec.get("package", name) if isinstance(spec, dict) else name
                rows.append({"name": name, "spec": ver, "version": locked_versions.get(real),
                             "declared": True, "dev": section != "dependencies"})
        return rows

    def _need_manifest(self):
        if not self.has_manifest():
            raise Fail("This repl has no Cargo.toml. Run `cargo init` in the shell first.")

    def add(self, name, version):
        self._need_manifest()
        run(["cargo", "add", f"{name}@{version}" if version else name])

    def remove(self, name):
        self._need_manifest()
        run(["cargo", "remove", name])

    def search(self, query):
        data = fetch_json(f"https://crates.io/api/v1/crates?q={q(query)}&per_page=20")
        return [{
            "name": c["name"], "version": c.get("max_stable_version") or c.get("max_version"),
            "description": c.get("description"), "downloads": c.get("recent_downloads"),
            "url": f"https://crates.io/crates/{c['name']}",
        } for c in data.get("crates", [])]


# ---- Go

GO_IMPORT_BLOCK = re.compile(r"^import\s*\((.*?)\)", re.M | re.S)
GO_IMPORT_LINE = re.compile(r'^import\s+(?:[\w.]+\s+)?"([^"]+)"', re.M)
GO_QUOTED = re.compile(r'"([^"]+)"')


class Go(Manager):
    id, label, tool, registry = "go", "Go", "go modules", "Go modules"
    languages = ("go", "golang")
    extensions = (".go",)
    manifests = ("go.mod",)
    name_hint = "module path, e.g. github.com/gin-gonic/gin"

    def _mod(self):
        text = read_or("go.mod")
        module = re.search(r"^module\s+(\S+)", text, re.M)
        reqs = []
        for block in re.findall(r"^require\s*\((.*?)\)", text, re.M | re.S):
            reqs += block.splitlines()
        reqs += re.findall(r"^require\s+([^(\s].*)$", text, re.M)
        out = []
        for ln in reqs:
            m = re.match(r"\s*(\S+)\s+(\S+)(.*)$", ln)
            if m:
                out.append((m.group(1), m.group(2), "// indirect" in m.group(3)))
        return (module.group(1) if module else None), out

    def packages(self):
        return [{"name": n, "spec": v, "version": v, "declared": True}
                for n, v, indirect in self._mod()[1] if not indirect]

    def _init(self):
        if not self.has_manifest():
            run(["go", "mod", "init", "repl"])

    def add(self, name, version):
        self._init()
        run(["go", "get", f"{name}@{version or 'latest'}"])
        # go get marks a module the code doesn't import yet `// indirect`;
        # it was asked for by name, so list it as a direct dependency.
        text = read_or("go.mod")
        new = re.sub(rf"(?m)^(\s*(?:require\s+)?{re.escape(name)}\s+\S+)\s*//\s*indirect\s*$", r"\1", text)
        if new != text:
            write("go.mod", new)

    def remove(self, name):
        if name not in {n for n, _v, _i in self._mod()[1]}:
            raise Fail(f"{name} isn't in go.mod")
        run(["go", "get", f"{name}@none"])

    def sync(self, state, cfg):
        if not self.has_manifest():
            return
        module, reqs = self._mod()
        imports = set()
        for f in files_with(".go"):
            src = source(f)
            for block in GO_IMPORT_BLOCK.findall(src):
                imports.update(GO_QUOTED.findall(block))
            imports.update(GO_IMPORT_LINE.findall(src))
        mods = [n for n, _v, _i in reqs] + ([module] if module else [])
        missing = sorted(
            i for i in imports
            if "." in i.split("/")[0]
            and not any(i == m or i.startswith(m + "/") for m in mods))
        key = digest_of([digest("go.mod", "go.sum"), missing])
        if synced(state, "go", key):
            return
        if missing and cfg["guess"]:
            say(f"Adding imported Go modules: {', '.join(missing)}")
            run(["go", "mod", "tidy"], check=False)
        elif reqs:
            run(["go", "mod", "download"], check=False)
        mark_synced(state, "go", digest_of([digest("go.mod", "go.sum"), missing]))

    def search(self, query):
        page = fetch(f"https://pkg.go.dev/search?q={q(query)}&m=package&limit=20", accept="text/html")
        out = []
        for m in re.finditer(r'data-clicked-package="([^"]+)"(.*?)(?=data-clicked-package=|$)', page, re.S):
            syn = re.search(r'data-test-id="snippet-synopsis">\s*(.*?)\s*</p>', m.group(2), re.S)
            path = html.unescape(m.group(1))
            if all(r["name"] != path for r in out):
                out.append({"name": path, "version": None,
                            "description": html.unescape(re.sub(r"<[^>]+>", "", syn.group(1))).strip() if syn else None,
                            "url": f"https://pkg.go.dev/{path}"})
        return out[:20]


# ---- Ruby

class Ruby(Manager):
    id, label, tool, registry = "ruby", "Ruby", "bundler", "RubyGems"
    languages = ("ruby",)
    extensions = (".rb",)
    manifests = ("Gemfile",)

    def packages(self):
        locked_versions = dict(re.findall(r"^    ([A-Za-z0-9_.-]+) \(([^)]+)\)$", read_or("Gemfile.lock"), re.M))
        rows = []
        for m in re.finditer(r"""^\s*gem\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?""", read_or("Gemfile"), re.M):
            rows.append({"name": m.group(1), "spec": m.group(2) or "", "version": locked_versions.get(m.group(1)),
                         "declared": True})
        return rows

    def add(self, name, version):
        if not self.has_manifest():
            run(["bundle", "init"])
        run(["bundle", "add", name] + (["--version", version] if version else []))

    def remove(self, name):
        run(["bundle", "remove", name])

    def sync_key(self):
        return digest("Gemfile", "Gemfile.lock")

    def sync(self, state, cfg):
        if not self.has_manifest():
            return
        if self.packages() and not synced(state, "ruby", self.sync_key()):
            say("Installing Ruby gems from Gemfile…")
            run(["bundle", "install"])
        mark_synced(state, "ruby", self.sync_key())

    def search(self, query):
        return [{
            "name": g["name"], "version": g.get("version"), "description": g.get("info"),
            "downloads": g.get("downloads"), "url": g.get("project_uri"),
        } for g in fetch_json(f"https://rubygems.org/api/v1/search.json?query={q(query)}")[:20]]


# ---- PHP

class Php(Manager):
    id, label, tool, registry = "php", "PHP", "composer", "Packagist"
    languages = ("php",)
    extensions = (".php",)
    manifests = ("composer.json",)
    name_hint = "vendor/package"

    def _json(self, name):
        try:
            data = json.loads(read(name))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def packages(self):
        data, lock = self._json("composer.json"), self._json("composer.lock")
        versions = {pk.get("name"): pk.get("version")
                    for s in ("packages", "packages-dev") for pk in lock.get(s, []) if isinstance(pk, dict)}
        rows = []
        for section in ("require", "require-dev"):
            for name, spec in sorted((data.get(section) or {}).items()):
                if name == "php" or name.startswith(("ext-", "lib-")):
                    continue
                rows.append({"name": name, "spec": str(spec), "version": versions.get(name),
                             "declared": True, "dev": section == "require-dev"})
        return rows

    def add(self, name, version):
        run(["composer", "require", "--no-interaction", f"{name}:{version}" if version else name])

    def remove(self, name):
        run(["composer", "remove", "--no-interaction", name])

    def sync_key(self):
        return digest("composer.json", "composer.lock")

    def sync(self, state, cfg):
        if not self.has_manifest():
            return
        if self.packages() and (not synced(state, "php", self.sync_key()) or not exists("vendor")):
            say("Installing PHP packages from composer.json…")
            run(["composer", "install", "--no-interaction"])
        mark_synced(state, "php", self.sync_key())

    def note(self):
        return "Load packages with require __DIR__ . '/vendor/autoload.php';"

    def search(self, query):
        data = fetch_json(f"https://packagist.org/search.json?q={q(query)}&per_page=20")
        return [{"name": r["name"], "version": None, "description": r.get("description"),
                 "downloads": r.get("downloads"), "url": r.get("url")} for r in data.get("results", [])]


# ---- Java / Kotlin (Maven Central; Maven or Gradle builds)

MVN_COORD = re.compile(r"^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$")
POM_TEMPLATE = """<?xml version="1.0" encoding="UTF-8"?>
<!-- Created by Repl's package manager: builds the code in this directory with Maven. -->
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>repl</groupId>
  <artifactId>{artifact}</artifactId>
  <version>1.0</version>
  <properties>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    <maven.compiler.release>{java}</maven.compiler.release>
    <exec.mainClass>{main}</exec.mainClass>{kotlin_props}
  </properties>
  <dependencies>{kotlin_deps}
  </dependencies>
  <build>
    <sourceDirectory>${{project.basedir}}</sourceDirectory>{kotlin_build}
  </build>
</project>
"""
POM_KOTLIN_PROPS = "\n    <kotlin.version>{kotlin}</kotlin.version>"
POM_KOTLIN_DEPS = """
    <dependency>
      <groupId>org.jetbrains.kotlin</groupId>
      <artifactId>kotlin-stdlib</artifactId>
      <version>${kotlin.version}</version>
    </dependency>"""
POM_KOTLIN_BUILD = """
    <plugins>
      <plugin>
        <groupId>org.jetbrains.kotlin</groupId>
        <artifactId>kotlin-maven-plugin</artifactId>
        <version>${kotlin.version}</version>
        <configuration>
          <sourceDirs><sourceDir>${project.basedir}</sourceDir></sourceDirs>
        </configuration>
        <executions>
          <execution><id>compile</id><goals><goal>compile</goal></goals></execution>
        </executions>
      </plugin>
    </plugins>"""
MAVEN_RUN = "mvn -q -B compile exec:java"
# Run commands of the single-file Java and Kotlin templates; a repl still using
# one is switched to Maven when it gets its first dependency.
SINGLE_FILE_RUNS = ("javac ", "kotlinc ")


def mask_blocks(text, tags):
    """`text` with these elements blanked out (same length), so a search for
    the project's own <dependencies> skips dependencyManagement, plugins..."""
    for tag in tags:
        text = re.sub(rf"<{tag}\b.*?</{tag}>", lambda m: " " * len(m.group(0)), text, flags=re.S)
    return re.sub(r"<!--.*?-->", lambda m: " " * len(m.group(0)), text, flags=re.S)


POM_NESTED = ("dependencyManagement", "build", "profiles", "reporting", "parent")


def maven_latest(group, artifact):
    """Newest release from the repository's own metadata (the search API is
    slower and often times out)."""
    try:
        meta = fetch(f"https://repo1.maven.org/maven2/{group.replace('.', '/')}/{artifact}/maven-metadata.xml",
                     accept="application/xml", timeout=20)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise
    m = re.search(r"<release>\s*([^<\s]+)\s*</release>", meta) or re.findall(r"<version>\s*([^<\s]+)\s*</version>", meta)
    if isinstance(m, list):
        return m[-1] if m else None
    return m.group(1)


def maven_pom_url(group, artifact, version):
    return (f"https://repo1.maven.org/maven2/{group.replace('.', '/')}/{artifact}/"
            f"{version}/{artifact}-{version}.pom")


class Jvm(Manager):
    id, label, registry = "jvm", "Java / Kotlin", "Maven Central"
    languages = ("java", "kotlin")
    extensions = (".java", ".kt")
    manifests = ("pom.xml", "build.gradle.kts", "build.gradle")
    name_hint = "group:artifact, e.g. com.google.code.gson:gson"

    @property
    def tool(self):
        return "gradle" if self.gradle_file() else "maven"

    def gradle_file(self):
        for f in ("build.gradle.kts", "build.gradle"):
            if exists(f):
                return f
        return None

    def manifest(self):
        return self.gradle_file() or "pom.xml"

    def note(self):
        if not self.has_manifest():
            return "The first package adds a pom.xml, and Run then builds with Maven."
        return None

    # -- Maven

    def _pom_deps(self, text):
        masked = mask_blocks(text, POM_NESTED)
        m = re.search(r"<dependencies>(.*?)</dependencies>", masked, re.S)
        if not m:
            return []
        out = []
        for d in re.finditer(r"<dependency>.*?</dependency>", text[m.start(1):m.end(1)], re.S):
            block = d.group(0)

            def tag(t, block=block):
                mm = re.search(rf"<{t}>\s*([^<]*?)\s*</{t}>", block)
                return mm.group(1) if mm else ""
            out.append({"name": f"{tag('groupId')}:{tag('artifactId')}", "spec": tag("version"),
                        "version": tag("version") or None, "declared": True,
                        "dev": tag("scope") == "test",
                        "_span": (m.start(1) + d.start(), m.start(1) + d.end())})
        return out

    def _gradle_deps(self, text):
        rows = []
        for m in re.finditer(r"""^\s*(implementation|api|compileOnly|runtimeOnly|testImplementation)\s*\(?\s*["']([^"':]+):([^"':]+)(?::([^"']+))?["']\s*\)?\s*$""",
                             text, re.M):
            rows.append({"name": f"{m.group(2)}:{m.group(3)}", "spec": m.group(4) or "",
                         "version": m.group(4), "declared": True, "dev": m.group(1).startswith("test")})
        return rows

    def packages(self):
        g = self.gradle_file()
        if g:
            return self._gradle_deps(read_or(g))
        rows = self._pom_deps(read_or("pom.xml"))
        for r in rows:
            r.pop("_span", None)
        return rows

    def _create_pom(self):
        cfg = replit_cfg()
        kotlin = cfg.get("language") == "kotlin" or (files_with(".kt") and not files_with(".java"))
        entry = str(cfg.get("entrypoint") or ("main.kt" if kotlin else "Main.java"))
        stem = os.path.splitext(os.path.basename(entry))[0]
        main = (stem[:1].upper() + stem[1:] + "Kt") if kotlin else stem
        props = subprocess.run(["java", "-XshowSettings:properties", "-version"],
                               capture_output=True, text=True).stderr
        jm = re.search(r"java\.specification\.version = (\d+)", props)
        kv = re.search(r"kotlinc-jvm (\d+\.\d+\.\d+)", subprocess.run(
            ["kotlinc", "-version"], capture_output=True, text=True).stderr) if kotlin else None
        artifact = re.sub(r"[^a-z0-9-]+", "-", os.environ.get("REPL_ID", "app").lower()) or "app"
        write("pom.xml", POM_TEMPLATE.format(
            artifact=artifact, java=jm.group(1) if jm else "21", main=main,
            kotlin_props=POM_KOTLIN_PROPS.format(kotlin=kv.group(1) if kv else "2.2.0") if kotlin else "",
            kotlin_deps=POM_KOTLIN_DEPS if kotlin else "",
            kotlin_build=POM_KOTLIN_BUILD if kotlin else ""))
        say("Created pom.xml so Maven can fetch dependencies")
        run_cmd = str(cfg.get("run", ""))
        if run_cmd.startswith(SINGLE_FILE_RUNS) or not run_cmd:
            text = read_or(".replit")
            new_line = f"run = {json.dumps(MAVEN_RUN)}"
            text, n = re.subn(r"(?m)^run\s*=.*$", lambda _m: new_line, text, count=1)
            write(".replit", text if n else new_line + "\n" + text)
            say(f"Run now builds with Maven: {MAVEN_RUN}")
        else:
            say(f"Your run command was left alone; use `{MAVEN_RUN}` to build with the dependencies")

    def add(self, name, version):
        if not MVN_COORD.match(name):
            raise Fail("Use Maven coordinates: group:artifact (e.g. com.google.code.gson:gson)")
        group, artifact = name.split(":")
        if not version:
            version = maven_latest(group, artifact)
            if not version:
                raise Fail(f"{name} isn't on Maven Central")
        elif not exists_url(maven_pom_url(group, artifact, version)):
            raise Fail(f"{name}:{version} isn't on Maven Central")
        g = self.gradle_file()
        if g:
            self._gradle_add(g, group, artifact, version)
            return
        if not exists("pom.xml"):
            self._create_pom()
        before = read("pom.xml")
        rows = self._pom_deps(before)
        text = before
        for r in rows:
            if r["name"] == name:
                a, b = r["_span"]
                text = text[:a] + text[b:]
                break
        dep = (f"<dependency>\n      <groupId>{group}</groupId>\n      <artifactId>{artifact}</artifactId>\n"
               f"      <version>{version}</version>\n    </dependency>")
        masked = mask_blocks(text, POM_NESTED)
        m = re.search(r"</dependencies>", masked)
        if m:
            text = text[:m.start()].rstrip() + "\n    " + dep + "\n  " + text[m.start():]
        else:
            end = masked.rfind("</project>")
            if end < 0:
                raise Fail("pom.xml has no </project>")
            text = text[:end].rstrip() + "\n  <dependencies>\n    " + dep + "\n  </dependencies>\n" + text[end:]
        write("pom.xml", text)
        say(f"Added {name}:{version} to pom.xml")
        # Fetch now, so a wrong coordinate fails here and Run starts warm.
        if run(["mvn", "-q", "-B", "dependency:resolve"], check=False) != 0:
            write("pom.xml", before)
            raise Fail("Maven couldn't resolve it; pom.xml was put back")

    def _gradle_add(self, g, group, artifact, version):
        text = read(g)
        coord = f"{group}:{artifact}"
        text = re.sub(rf"""(?m)^\s*\w+\s*\(?\s*["']{re.escape(coord)}(?::[^"']*)?["']\s*\)?\s*\n""", "", text)
        line = (f'    implementation("{coord}:{version}")' if g.endswith(".kts")
                else f"    implementation '{coord}:{version}'")
        m = re.search(r"(?m)^dependencies\s*\{[^\n]*\n", text)
        if m:
            text = text[:m.end()] + line + "\n" + text[m.end():]
        else:
            text = text.rstrip() + "\n\ndependencies {\n" + line + "\n}\n"
        write(g, text)
        say(f"Added {coord}:{version} to {g}")

    def remove(self, name):
        g = self.gradle_file()
        if g:
            text = read(g)
            new = re.sub(rf"""(?m)^\s*\w+\s*\(?\s*["']{re.escape(name)}(?::[^"']*)?["']\s*\)?\s*\n""", "", text)
            if new == text:
                raise Fail(f"{name} isn't in {g}")
            write(g, new)
        else:
            text = read_or("pom.xml")
            for r in self._pom_deps(text):
                if r["name"] == name:
                    a, b = r["_span"]
                    line_start = text.rfind("\n", 0, a)
                    write("pom.xml", text[:line_start if line_start >= 0 else a] + text[b:])
                    break
            else:
                raise Fail(f"{name} isn't in pom.xml")
        say(f"Removed {name}")

    def search(self, query):
        data = fetch_json(f"https://search.maven.org/solrsearch/select?q={q(query)}&rows=20&wt=json", timeout=20)
        return [{"name": d["id"], "version": d.get("latestVersion"), "description": None,
                 "url": f"https://central.sonatype.com/artifact/{d.get('g')}/{d.get('a')}"}
                for d in data.get("response", {}).get("docs", [])]


# ---- .NET

class Dotnet(Manager):
    id, label, tool, registry = "dotnet", ".NET", "dotnet", "NuGet"
    languages = ("csharp", "c#", "fsharp", "f#", "dotnet")
    extensions = (".cs", ".fs")

    def project(self):
        found = sorted(glob.glob(p("*.csproj")) + glob.glob(p("*.fsproj")))
        return os.path.basename(found[0]) if found else None

    def has_manifest(self):
        return self.project() is not None

    def manifest(self):
        return self.project() or "*.csproj"

    def packages(self):
        proj = self.project()
        text = read_or(proj) if proj else ""
        return [{"name": m.group(1), "spec": m.group(2) or "", "version": m.group(2), "declared": True}
                for m in re.finditer(r'<PackageReference\s+Include="([^"]+)"(?:\s+Version="([^"]+)")?', text)]

    def _proj(self):
        proj = self.project()
        if not proj:
            raise Fail("This repl has no .csproj. Run `dotnet new console` in the shell first.")
        return proj

    def add(self, name, version):
        run(["dotnet", "add", self._proj(), "package", name] + (["--version", version] if version else []))

    def remove(self, name):
        run(["dotnet", "remove", self._proj(), "package", name])

    def search(self, query):
        data = fetch_json(f"https://azuresearch-usnc.nuget.org/query?q={q(query)}&take=20&prerelease=false")
        return [{"name": d["id"], "version": d.get("version"), "description": d.get("description"),
                 "downloads": d.get("totalDownloads"), "url": f"https://www.nuget.org/packages/{d['id']}"}
                for d in data.get("data", [])]


# ---- R

R_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9.]*$")
R_USES = re.compile(r"""\b(?:library|require|requireNamespace)\s*\(\s*["']?([A-Za-z][A-Za-z0-9.]*)|\b([A-Za-z][A-Za-z0-9.]*):::?[A-Za-z.]""")
R_LIB_ENV = 'Sys.getenv("R_LIBS_USER")'


class R(Manager):
    id, label, tool, registry = "r", "R", "install.packages", "CRAN"
    languages = ("r",)
    extensions = (".r", ".R", ".Rmd")
    versioned = False

    def note(self):
        return "Installs the current CRAN release (Posit's prebuilt binaries)."

    def _installed(self, all_libs=False):
        lib = "" if all_libs else f"lib.loc = {R_LIB_ENV}"
        out = capture(["Rscript", "-e", f"ip <- installed.packages({lib}); "
                       'cat(paste(ip[, "Package"], ip[, "Version"], sep = "\\t"), sep = "\\n")'])
        rows = {}
        for ln in (out or "").splitlines():
            if "\t" in ln:
                n, v = ln.split("\t", 1)
                rows[n] = v
        return rows

    def packages(self):
        return [{"name": n, "spec": "", "version": v, "declared": True}
                for n, v in sorted(self._installed().items())]

    def _check(self, name):
        if not R_NAME.match(name):
            raise Fail(f"{name!r} isn't a valid R package name")

    def _install(self, names):
        for n in names:
            self._check(n)
        vec = ", ".join(f'"{n}"' for n in names)
        run(["Rscript", "-e", f"install.packages(c({vec}), lib = {R_LIB_ENV}); "
             f"ok <- vapply(c({vec}), requireNamespace, logical(1), quietly = TRUE); "
             "if (!all(ok)) quit(status = 1)"])

    def add(self, name, version):
        self._install([name])

    def remove(self, name):
        self._check(name)
        if name not in self._installed():
            raise Fail(f"{name} isn't installed in this repl")
        run(["Rscript", "-e", f'remove.packages("{name}", lib = {R_LIB_ENV})'])

    def sync(self, state, cfg):
        if not (cfg["guess"] and self.primary(cfg["language"])):
            return
        used = set()
        for f in files_with(*self.extensions):
            for m in R_USES.finditer(source(f)):
                used.add(m.group(1) or m.group(2))
        used = sorted(n for n in used if n.lower() not in cfg["ignored"])
        try:
            lib_mtime = os.stat(os.path.join(PKG, "R")).st_mtime_ns
        except OSError:
            lib_mtime = 0
        key = digest_of([used, lib_mtime])
        if not used or synced(state, "r", key):
            return
        failed = set(state.get("r_failed", []))
        todo = sorted(set(used) - set(self._installed(all_libs=True)) - failed)
        if todo:
            say(f"Installing R packages used by the code: {', '.join(todo)}")
            install_batch(todo, self._install, failed,
                          lambda n: registry_has(f"https://crandb.r-pkg.org/{q(n)}"))
            state["r_failed"] = sorted(failed)
        mark_synced(state, "r", digest_of([used, os.stat(os.path.join(PKG, "R")).st_mtime_ns]))

    def search(self, query):
        body = json.dumps({"query": {"multi_match": {"query": query, "fields": ["Package^10", "Title^3", "Description"]}},
                           "size": 20, "_source": ["Package", "Title", "Version"]}).encode()
        req = urllib.request.Request("https://search.r-pkg.org/package/_search", data=body,
                                     headers={"User-Agent": UA, "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read())
        return [{"name": h["_source"]["Package"], "version": h["_source"].get("Version"),
                 "description": h["_source"].get("Title"),
                 "url": f"https://cran.r-project.org/package={h['_source']['Package']}"}
                for h in data.get("hits", {}).get("hits", [])]


# ---- Perl

PERL_DIR = os.path.join(PKG, "perl")
PERL_MOD = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z0-9_]+)*$")
PERL_VERSIONS = r'for my $m (@ARGV) { (my $f = "$m.pm") =~ s{::}{/}g; my $v = eval { require $f; $m->VERSION }; print "$m\t", ($v // ""), "\n" }'


class Perl(Manager):
    id, label, tool, registry = "perl", "Perl", "cpanm", "CPAN"
    languages = ("perl",)
    extensions = (".pl", ".pm")
    manifests = ("cpanfile",)
    name_hint = "module, e.g. Mojolicious"

    def _requires(self):
        return [(m.group(1), m.group(2) or "") for m in re.finditer(
            r"""^\s*requires\s+['"]([^'"]+)['"](?:\s*(?:,|=>)\s*['"]?([^'";\s]+)['"]?)?""", read_or("cpanfile"), re.M)]

    def packages(self):
        reqs = self._requires()
        versions = {}
        if reqs:
            out = capture(["perl", "-e", PERL_VERSIONS, *[n for n, _ in reqs]]) or ""
            versions = dict(ln.split("\t", 1) for ln in out.splitlines() if "\t" in ln)
        return [{"name": n, "spec": s, "version": versions.get(n) or None, "declared": True} for n, s in reqs]

    def _check(self, name):
        if not PERL_MOD.match(name):
            raise Fail(f"{name!r} isn't a Perl module name")

    def add(self, name, version):
        self._check(name)
        run(["cpanm", "--notest", "-l", PERL_DIR, f"{name}@{version}" if version else name])
        lines = [ln for ln in read_or("cpanfile").splitlines()
                 if not re.match(rf"""^\s*requires\s+['"]{re.escape(name)}['"]""", ln)]
        lines.append(f"requires '{name}'" + (f", '== {version}'" if version else "") + ";")
        if not exists("cpanfile"):
            open(p("cpanfile"), "a").close()
        write("cpanfile", "\n".join(lines) + "\n")

    def remove(self, name):
        self._check(name)
        lines = read_or("cpanfile").splitlines()
        kept = [ln for ln in lines if not re.match(rf"""^\s*requires\s+['"]{re.escape(name)}['"]""", ln)]
        run(["cpanm", "--uninstall", "--force", "-l", PERL_DIR, name], check=False)
        if kept != lines:
            write("cpanfile", "\n".join(kept) + ("\n" if kept else ""))

    def sync_key(self):
        return digest("cpanfile")

    def sync(self, state, cfg):
        if not self.has_manifest():
            return
        if self._requires() and not synced(state, "perl", self.sync_key()):
            say("Installing Perl modules from cpanfile…")
            run(["cpanm", "--notest", "--installdeps", "-l", PERL_DIR, "."])
        mark_synced(state, "perl", self.sync_key())

    def search(self, query):
        data = fetch_json(f"https://fastapi.metacpan.org/v1/search/autocomplete?q={q(query)}&size=20")
        out = []
        for h in data.get("hits", {}).get("hits", []):
            f = h.get("fields", {})
            name = f.get("documentation")
            if name and all(r["name"] != name for r in out):
                out.append({"name": name, "version": (f.get("release") or "").rsplit("-", 1)[-1] or None,
                            "description": f.get("distribution"), "url": f"https://metacpan.org/pod/{name}"})
        return out


# ---- Lua

LUA_DIR = os.path.join(PKG, "lua")


class Lua(Manager):
    id, label, tool, registry = "lua", "Lua", "luarocks", "LuaRocks"
    languages = ("lua",)
    extensions = (".lua",)

    def note(self):
        return "Rocks install into .repl/lua; require() finds them."

    def packages(self):
        out = capture(["luarocks", "--tree", LUA_DIR, "list", "--porcelain"]) or ""
        rows = []
        for ln in out.splitlines():
            parts = ln.split("\t")
            if len(parts) >= 2:
                rows.append({"name": parts[0], "spec": "", "version": parts[1], "declared": True})
        return rows

    def add(self, name, version):
        run(["luarocks", "--tree", LUA_DIR, "install", name] + ([version] if version else []))

    def remove(self, name):
        run(["luarocks", "--tree", LUA_DIR, "remove", name])

    def search(self, query):
        page = fetch(f"https://luarocks.org/search?q={q(query)}", accept="text/html")
        out = []
        for m in re.finditer(r'<a class="title" href="/modules/([^/"]+)/([^"]+)">.*?</a>(.*?)</li>', page, re.S):
            summary = re.search(r'<div class="summary">(.*?)</div>', m.group(3), re.S)
            out.append({"name": html.unescape(m.group(2)), "version": None,
                        "description": html.unescape(re.sub(r"<[^>]+>", "", summary.group(1))).strip() if summary else None,
                        "url": f"https://luarocks.org/modules/{m.group(1)}/{m.group(2)}"})
        return out[:20]


# ---- Haskell

CABAL_DIR = os.path.join(PKG, "cabal")
SHARED_HACKAGE = "/opt/cabal/packages/hackage.haskell.org"
HS_PKG = re.compile(r"^[A-Za-z0-9]+(?:-[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*)*$")
HS_ID = re.compile(r"^package-id\s+(.+?)-(\d+(?:\.\d+)*)(?:-[0-9a-f]+)?\s*$")
HS_BOOT = {"base", "ghc-prim", "ghc-internal", "ghc-bignum", "rts"}


class Haskell(Manager):
    id, label, tool, registry = "haskell", "Haskell", "cabal", "Hackage"
    languages = ("haskell",)
    extensions = (".hs",)

    def note(self):
        if glob.glob(p("*.cabal")):
            return "This is a cabal project: list packages under build-depends in its .cabal file."
        return "Packages build from source and are registered in .ghc.environment.*, which runghc reads."

    def _env_file(self):
        found = sorted(glob.glob(p(".ghc.environment.*")))
        return found[0] if found else None

    def manifest(self):
        env = self._env_file()
        return os.path.basename(env) if env else ".ghc.environment"

    def packages(self):
        env = self._env_file()
        rows = []
        for ln in (read_or(env).splitlines() if env else []):
            m = HS_ID.match(ln)
            if m and m.group(1) not in HS_BOOT:
                rows.append({"name": m.group(1), "spec": "", "version": m.group(2), "declared": True})
        return rows

    def _prepare(self):
        """Link the image's Hackage index into this repl's CABAL_DIR, so
        cabal finds packages without a 1 GB `cabal update` per repl."""
        if glob.glob(p("*.cabal")):
            raise Fail("This is a cabal project: add packages to build-depends in its .cabal file")
        repo = os.path.join(CABAL_DIR, "packages", "hackage.haskell.org")
        os.makedirs(repo, exist_ok=True)
        if os.path.isdir(SHARED_HACKAGE):
            for f in os.listdir(SHARED_HACKAGE):
                dst = os.path.join(repo, f)
                if not os.path.lexists(dst):
                    os.symlink(os.path.join(SHARED_HACKAGE, f), dst)
        if not os.path.exists(os.path.join(CABAL_DIR, "config")):
            capture(["cabal", "user-config", "init"])

    def add(self, name, version):
        if not HS_PKG.match(name):
            raise Fail(f"{name!r} isn't a Hackage package name")
        self._prepare()
        args = ["cabal", "install", "--lib", "--package-env", ".", name]
        if version:
            args[2:2] = ["--constraint", f"{name} == {version}"]
        run(args)

    def remove(self, name):
        env = self._env_file()
        lines = read_or(env).splitlines() if env else []
        kept = [ln for ln in lines if not ((m := HS_ID.match(ln)) and m.group(1) == name)]
        if kept == lines:
            raise Fail(f"{name} isn't in this repl's package environment")
        write(env, "\n".join(kept) + "\n")
        say(f"Removed {name} from {os.path.basename(env)}")

    def search(self, query):
        data = fetch_json(f"https://hackage.haskell.org/packages/search?terms={q(query)}")
        return [{"name": d["name"], "version": None, "description": None,
                 "url": f"https://hackage.haskell.org/package/{d['name']}"} for d in data[:20]]


MANAGERS = [Python(), Node(), Rust(), Go(), Ruby(), Php(), Jvm(), Dotnet(), R(), Perl(), Lua(), Haskell()]
BY_ID = {m.id: m for m in MANAGERS}


# ---------------------------------------------------------------- search

_cache = {}
CACHE_TTL = 600


def cached(key, fn):
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < CACHE_TTL:
        return hit[1]
    value = fn()
    _cache[key] = (time.monotonic(), value)
    if len(_cache) > 300:
        for k in sorted(_cache, key=lambda k: _cache[k][0])[:100]:
            _cache.pop(k, None)
    return value


PYPI_TOP_FILE = "/tmp/repl-pypi-top.json"


def pypi_top():
    """The ~15,000 most downloaded PyPI projects, most popular first. PyPI's
    own search has no API, so names are matched against this list."""
    def load():
        try:
            if time.time() - os.stat(PYPI_TOP_FILE).st_mtime < 7 * 86400:
                with open(PYPI_TOP_FILE) as f:
                    return json.load(f)
        except (OSError, ValueError):
            pass
        rows = fetch_json("https://hugovk.github.io/top-pypi-packages/top-pypi-packages.min.json", timeout=20)["rows"]
        top = [[r["project"], r["download_count"]] for r in rows]
        try:
            with open(PYPI_TOP_FILE, "w") as f:
                json.dump(top, f)
        except OSError:
            pass
        return top
    return cached("pypi-top", load)


def pypi_project(name):
    try:
        info = fetch_json(f"https://pypi.org/pypi/{q(name)}/json")["info"]
        return {"name": info["name"], "version": info.get("version"), "description": info.get("summary"),
                "url": info.get("package_url") or f"https://pypi.org/project/{name}/"}
    except (urllib.error.URLError, ValueError, KeyError, TimeoutError):
        return None


def search_pypi(query):
    qn = norm_py(query)
    try:
        top = pypi_top()
    except (urllib.error.URLError, ValueError, KeyError, TimeoutError):
        top = []
    exact, prefix, contains = [], [], []
    for name, downloads in top:
        n = norm_py(name)
        if n == qn:
            exact.append((name, downloads))
        elif n.startswith(qn):
            prefix.append((name, downloads))
        elif qn in n:
            contains.append((name, downloads))
    hits = (exact + prefix + contains)[:20]
    # Descriptions for the first few; PyPI's JSON is one request per project.
    with ThreadPoolExecutor(4) as pool:
        details = list(pool.map(pypi_project, [n for n, _ in hits[:6]]))
    out = []
    for i, (name, downloads) in enumerate(hits):
        d = details[i] if i < len(details) and details[i] else {
            "name": name, "version": None, "description": None, "url": f"https://pypi.org/project/{name}/"}
        out.append({**d, "downloads": downloads})
    if not exact:
        d = pypi_project(query)  # anything on PyPI, popular or not
        if d:
            out.insert(0, {**d, "downloads": None})
    return out[:20]


def search(manager_id, query):
    m = BY_ID.get(manager_id)
    query = query.strip()[:100]
    if not m or not query:
        return []
    return cached(f"{manager_id}:{query.lower()}", lambda: m.search(query))


# ---------------------------------------------------------------- entry points

def info():
    cfg = packager_cfg()
    lang = cfg["language"]
    found = [m for m in MANAGERS if m.detected(lang)]
    found.sort(key=lambda m: (not m.primary(lang), lang not in m.languages))
    return {
        "managers": [m.describe() for m in found],
        "available": [{"id": m.id, "label": m.label} for m in MANAGERS],
        "guessImports": cfg["guess"],
    }


def sync():
    """Never fails Run: problems are printed and the program starts anyway."""
    try:
        ensure()
        cfg = packager_cfg()
        with locked():
            state = load_state()
            for m in MANAGERS:
                if not m.detected(cfg["language"]):
                    continue
                try:
                    m.sync(state, cfg)
                except Fail as e:
                    print(f"{RED}Packages ({m.label}): {e}{RESET}", flush=True)
                save_state(state)
    except Exception as e:  # noqa: BLE001 - Run must still start
        print(f"{RED}Package manager error: {e}{RESET}", flush=True)
    return 0


def change(op, manager_id, name, version=""):
    m = BY_ID.get(manager_id)
    if not m:
        raise Fail(f"unknown package manager {manager_id!r}")
    name, version = name.strip(), version.strip()
    if not NAME_RE.match(name):
        raise Fail(f"{name!r} isn't a valid package name")
    if version and (not m.versioned or not VERSION_RE.match(version) or version.startswith("-")):
        raise Fail(f"{version!r} isn't a valid version here")
    ensure()
    with locked():
        if op == "add":
            m.add(name, version)
        else:
            m.remove(name)
        # The manifest now matches what's installed: Run needn't install again.
        if hasattr(m, "sync_key"):
            state = load_state()
            mark_synced(state, m.id, m.sync_key())
            save_state(state)


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ""
    try:
        if cmd == "ensure":
            ensure()
        elif cmd == "sync":
            return sync()
        elif cmd == "info":
            print(json.dumps(info()))
        elif cmd in ("add", "remove") and len(argv) >= 4:
            change(cmd, argv[2], argv[3], argv[4] if len(argv) > 4 else "")
            say("Done.")
        elif cmd == "search" and len(argv) >= 4:
            print(json.dumps(search(argv[2], " ".join(argv[3:]))))
        else:
            print(__doc__)
            return 2
    except Fail as e:
        print(f"{RED}{e}{RESET}", flush=True)
        return 1
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        print(f"{RED}Couldn't reach the package registry: {getattr(e, 'reason', e)}{RESET}", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
