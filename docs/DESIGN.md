# Replit Clone ("Repl") — Design Document

A self-hosted clone of 2020-era Replit: sign up, pick a language or framework,
get a real Linux container, and write/run code from the browser. Every repl
gets a code editor, a console, a shell, a web preview for whatever server you
start, and a VNC desktop for GUI programs (Tkinter, Swing, pygame).

The architecture follows [PlottedPlant](https://github.com/arelyx/plottedplant)
(FastAPI + Postgres + Hocuspocus + nginx + React/shadcn). The document
editor becomes a code editor and the PlantUML renderer becomes a container
runtime. Versioning is plain git, with each repl being a git repository.

---

## 1. Goals and non-goals

**Goals**

- Any major language: Python, Node.js, TypeScript, Java, Kotlin, C, C++, C#,
  Go, Rust, Ruby, PHP, Lua, Perl, Bash, Haskell, R, Fortran, Pascal, Assembly,
  Scheme, Common Lisp.
- GUI programs rendered in the browser over VNC (noVNC).
- Ad-hoc web servers (Flask, FastAPI, Django, Express, PHP, Spring Boot...)
  reachable at a per-repl preview URL.
- Static HTML/CSS/JS playgrounds.
- Framework templates (React + Vite, Vue + Vite, Express, Django, Spring Boot).
- Real-time multiplayer editing (Yjs/Hocuspocus, same as PlottedPlant).
- Versioning with git: commit, history, diff, restore.
- Sharing: collaborators (viewer/editor), public repls, forking.

**Non-goals (for this iteration)**

- Multi-host scheduling (one Docker host).
- Hardened multi-tenant isolation (gVisor/Firecracker). See §9.
- Billing, quotas UI, always-on deployments.

---

## 2. Architecture

```
                    ┌──────────────────────── host :8380 ───────────────────────┐
Browser ──HTTP/WS──▶│ nginx                                                     │
                    │  /                → SPA (built React app)                  │
                    │  /api/*           → backend:8000 (FastAPI)                 │
                    │  /collab          → collaboration:1234 (Hocuspocus WS)     │
                    │  /ws/repls/{id}/* → auth_request → repl-{id}:8008 / :6080   │
                    │  {id}-{port}.preview.localhost → repl-{id}:{port}          │
                    └───────────────────────────────────────────────────────────┘
backend ──docker.sock──▶ Docker Engine ──▶ repl-{id} containers (image repl-polyglot)
backend ──▶ Postgres (users, repls, collaborators)
backend ──▶ ${REPLS_DIR}/{id}  (bind-mounted git working tree; the source of truth for files)
collaboration ──▶ backend /api/v1/internal/*  (auth, load/store file content)
```

| Service | Tech | Role |
|---|---|---|
| `nginx` | nginx 1.28 | Single entrypoint. Serves SPA, proxies API/WS, gates container WS with `auth_request`, routes preview subdomains to containers by Docker DNS. |
| `backend` | FastAPI, SQLAlchemy async, docker SDK, git CLI | Auth, repl CRUD, file API, git API, container lifecycle, sharing, nginx auth hook, idle reaper. |
| `collaboration` | Hocuspocus (Node) | Yjs rooms per open file (`{replId}::{path}`); loads from and stores to the file on disk via the backend. |
| `postgres` | Postgres 18 | Users, repls, collaborators. |
| `repl-{id}` | `repl-polyglot` image | One per running repl. Runs the in-container agent, Xvfb + fluxbox + x11vnc + websockify (noVNC), and user code. |

### Why these choices

- **One fat "polyglot" image** (like Replit's polygott) instead of an image per
  language. Templates can mix languages (a Flask backend with a React
  frontend), switching language does not need a new container, and there is
  only one image to build and cache. The cost is a large image (~10 GB), paid once.
- **Files live on the host, bind-mounted into the container.** The backend
  reads and writes files without the container running, so the editor works
  when the repl is stopped. git runs from the backend against the same
  directory. The container sees the same tree at `/home/runner/app`.
- **nginx routes straight to containers** using Docker's embedded DNS
  (`repl-{id}` on the `rc-repls` network). The backend never relays terminal
  bytes. It only answers nginx's `auth_request` subrequest (yes/no plus
  permission). That keeps the Python process out of the hot path for PTY and
  VNC traffic.
- **Preview by subdomain** (`{id}-{port}.preview.localhost:8380`), not by path
  prefix, so apps using absolute URLs (`/static/app.js`) work unchanged.
  `*.localhost` resolves to loopback in all modern browsers, so local dev
  needs no DNS setup. Previews are public, as `repl.co` URLs were.
- **In-container agent** (Python/aiohttp, stdlib `pty`) rather than `docker
  exec` relayed through the backend. It owns the "Run" process, so output
  scrollback survives page reloads and many viewers can share one console. It
  also spawns shells and reports listening ports for the web-preview picker.
- **Git for versioning** in place of PlottedPlant's version tables, as requested.
  Commits are made by the backend as the acting user (`--author`).
- **Cookie auth (httpOnly JWT).** PlottedPlant uses Clerk. Self-hosting needs
  no third party, and cookies flow on WebSocket upgrades and nginx
  `auth_request` without extra token plumbing.

---

## 3. Data model (Postgres)

```
users(id PK serial, email UNIQUE, username UNIQUE, password_hash, display_name, created_at)
repls(id PK varchar(12) [a-z0-9], owner_id FK users, name, description,
      template, language, is_public bool, forked_from varchar NULL,
      created_at, updated_at, last_opened_at)
repl_collaborators(repl_id FK, user_id FK, role enum('viewer','editor'), created_at, PK(repl_id,user_id))
```

Permissions: `owner` > `editor` > `viewer`. Public repls grant `viewer` to everyone.
Viewers can read files, view git history, view the console and the preview, and fork.
Only `editor`+ may write files, run, use the shell, commit, or open VNC input.

Repl id: 10 random `[a-z0-9]` characters, safe as a DNS label and container name.

## 4. On-disk layout

```
${REPLS_DIR}/{replId}/            # git working tree, owned by uid 1000
  .replit                         # run config (TOML subset)
  .git/
  ...user files
```

`.replit`:
```toml
run = "python3 main.py"           # executed with bash -lc in /home/runner/app
language = "python"
entrypoint = "main.py"            # file opened by default in the editor
gui = false                       # template hint: show the Display (VNC) tab
port = 8000                       # template hint: default web preview port
```

## 5. Container runtime

- Image: `repl-polyglot:latest` (`runner/Dockerfile`).

### Toolchains are current upstream releases

The point is a usable code box, not a period piece, so every language runs
its latest stable release. The base is the current Ubuntu LTS (26.04).
Everywhere the distro package trails upstream, the toolchain comes from its
own official channel at a pinned version:

| Language | Version | Source |
|---|---|---|
| C / C++ / Fortran | GCC 16.2 | official `gcc` image (`/usr/local`) |
| C / C++ | Clang 23 | apt.llvm.org |
| Python | 3.14.8 | python-build-standalone via uv (bundles Tk) |
| Node.js | 26.10 | nodejs.org |
| TypeScript | 7.0 | npm |
| Go | 1.27.1 | go.dev |
| Rust | 1.99.0 | rustup |
| Java | Temurin 27 | Adoptium |
| Maven | 3.10.0 | Apache |
| Kotlin | 2.4.20 | JetBrains |
| C# / .NET | SDK 10.0.401 | dotnet-install |
| Ruby | 4.0.7 | built from source |
| PHP | 8.5.11 | built from source |
| Perl | 5.44.0 | built from source |
| Lua | 5.5.1 | built from source |
| NASM | 3.02 | built from source |
| Haskell | GHC 9.14.1 | ghcup |
| R | 4.6.1 | CRAN's Ubuntu repo |
| Common Lisp | SBCL 2.6.9 | sbcl.org binary |
| Pascal / Scheme | FPC 3.2.2, Guile 3.0.11 | Ubuntu (already the latest upstream) |

The pins are `ARG`s at the top of the Dockerfile, so builds are
reproducible.

- **Bumping the pins:** `make update-versions` (`runner/update-versions.py`)
  asks each project's release feed, or endoflife.date, for the latest stable
  release and rewrites the pins. A weekly GitHub Actions workflow runs it and
  opens a PR when something moved.
- **Checking a build:** the build ends by running `repl-versions`, which
  prints every toolchain's version and fails the build if any of them
  doesn't start. `make versions` runs the same check against a built image.
- **Templates:** they follow the toolchains (Go `go 1.27`, `net10.0`, Rust
  edition 2024, C++26, Spring Boot 4.1 on Java 27, React 19 and Vue 3.5 on
  Vite 8, Express 5). Version numbers are kept out of template descriptions
  so they can't go stale.

- Container name `repl-{id}`, labels `repl.id={id}`. Each repl gets its own
  bridge network `rc-repl-{id}`, which only the repl, nginx, and the backend
  join. On a shared network every repl could reach every other repl's
  unauthenticated agent and noVNC. The backend reattaches nginx and itself
  to these networks every minute, because recreating those containers drops
  the attachments. Docker's default address pools run out after a few dozen
  networks, so each repl network gets a /28 carved from `REPL_SUBNET_POOL`
  (default `10.213.0.0/16`, room for 4096 running repls).
- Mount `${REPLS_HOST_DIR}/{id}` → `/home/runner/app`.
- Limits (all settings, defaults shown): `REPL_CPUS=1.0`, `REPL_MEMORY=2g`
  with memory+swap equal (no swap), `REPL_PIDS=512`, `/tmp` a tmpfs of
  `REPL_TMPFS_SIZE=512m` (`exec`, so users can compile into it; it counts
  against the memory limit), json-file logs rotated at
  `REPL_LOG_MAX_SIZE=5m` x `REPL_LOG_MAX_FILE=2`, `cap_drop=ALL` with nothing
  added back, `no-new-privileges`, `oom_score_adj=800`. Containers live under
  the systemd slice `REPL_CGROUP_PARENT=repl-containers.slice`, so the whole
  fleet can be capped in one place (`systemctl set-property
  repl-containers.slice CPUQuota=... MemoryMax=...`); if Docker rejects the
  slice (cgroupfs driver) repls start under Docker's default parent. Labels:
  `repl.id={id}`, `repl.user={id of the user who started it}`.
- Caps: a user may have `MAX_RUNNING_PER_USER=2` repls running; starting
  another stops their least recently active one(s), and the start response
  lists them (`{"status":"running","stopped":["..."]}`). Past
  `MAX_RUNNING_REPLS=40` running repls, start returns 503.
- Disk: `REPL_DISK_QUOTA_MB=2048` covers the repl directory plus the
  container's writable layer (`SizeRw`: `~/.cache`, `~/.local`, ...). Start
  refuses (507) a repl whose directory is over quota; the reaper stops
  running ones that go over.
- Entrypoint (`/opt/replagent/entrypoint.sh`) starts Xvfb `:0` (960x600),
  fluxbox, x11vnc (`-forever -shared -nopw`, localhost only), websockify on
  `127.0.0.1:6080` serving `/usr/share/novnc`, then the agent on `:8008`.
  Only the agent receives `REPL_AGENT_TOKEN`, and it removes it from its
  own environment before starting anything.
- Lifecycle: `POST /repls/{id}/start` creates the network and container, then
  waits until the agent's `/health` answers. Startup takes about 0.6 s, so
  containers are disposable: stopping a repl removes the container and its
  network, and only the files on disk persist. Opening a repl calls start. A
  reaper runs every minute and stops containers with no *editor* connected
  for `IDLE_TIMEOUT_MINUTES` (default 30; anonymous viewers of a public
  repl's console don't count), containers older than `MAX_CONTAINER_HOURS`
  (default 12), and containers over the disk quota.

### Agent protocol (port 8008)

| Endpoint | Purpose |
|---|---|
| `GET /health` | `{"ok":true,"clients":N,"editors":E,"viewers":V}` |
| `GET /ports` | `{"ports":[3000,8000]}`: TCP ports listening on any interface, excluding 8008/6080/5900. |
| `WS /run` | Attach to the single shared Run process. |
| `WS /shell` | A fresh `bash -l` PTY per connection. |
| `WS /lsp/{server}` | A language server (see `lsp_bridge.py`). |
| `GET`/`WS /vnc/{path}` | noVNC's files and websockify, proxied to `127.0.0.1:6080`. |

Every request must carry `X-Agent-Token`, or the agent answers 401. The
token is `HMAC-SHA256(INTERNAL_SECRET, "agent:" + repl_id)` (hex). The
backend sends it on its own `/health` and `/ports` calls and returns it from
`/internal/auth-repl`; nginx forwards it on the `/ws/repls/...` routes.

WebSocket messages are JSON text frames:

- client → agent: `{"type":"input","data":"..."}`, `{"type":"resize","cols":80,"rows":24}`,
  `/run` only: `{"type":"start"}` (kill any current run, re-read `.replit`, start `run`),
  `{"type":"stop"}`.
- agent → client: `{"type":"output","data":"..."}`,
  `/run` only: `{"type":"status","running":true|false,"exitCode":int|null,"command":"..."}`
  (sent on connect and on every change). On connect to `/run` the agent first replays
  up to 256 KB of scrollback.

## 6. HTTP API (`/api/v1`)

Auth cookie: `access_token`, or `__Host-access_token` when cookies are Secure
(`PUBLIC_SCHEME=https`). httpOnly, SameSite=Lax, JWT HS256 carrying the user's
`token_version`, lifetime `JWT_EXPIRE_DAYS` (7). Logout and password changes bump
`token_version`, which revokes every token the user holds.
Errors: `{"detail": "..."}` with the usual status codes.

**Auth**
- `POST /auth/register {email, username, password (>= 10 chars), display_name?}` → `User` and sets the cookie
  (403 when `ALLOW_SIGNUP=false`; one generic 409 for a taken email or username)
- `POST /auth/login {login, password}` (`login` = email or username) → `User` and sets the cookie
- `POST /auth/logout` → 204 (revokes all of the user's sessions)
- `POST /auth/password {current_password, new_password}` → `User`, re-issues this session's cookie, revokes the others

Login and register are rate limited per client IP (`AUTH_RATE_PER_MIN`, `REGISTER_RATE_PER_HOUR`)
and failed logins per account (`LOGIN_MAX_FAILURES` per `LOGIN_FAILURE_WINDOW_MIN`) → 429 with `Retry-After`.
- `GET /auth/me` → `User` | 401

`User = {id, email, username, display_name}`

**Templates**
- `GET /templates` → `Template[]`
  `Template = {slug, name, description, language, category: "language"|"web"|"gui"|"static"|"framework", icon, run, gui, port}`

**Repls**
- `GET /repls` → `{owned: Repl[], shared: Repl[]}`
- `GET /explore` → `Repl[]` (public)
- `POST /repls {name, template, description?, is_public?}` → `Repl`
- `GET /repls/{id}` → `Repl` (incl. `role` for the caller)
- `PATCH /repls/{id} {name?, description?, is_public?}` → `Repl` (owner)
- `DELETE /repls/{id}` → 204 (owner; removes container + files)
- `POST /repls/{id}/fork {name?}` → `Repl`

Create and fork return 403 past `MAX_REPLS_PER_USER`; fork returns 413 when the source is larger than `REPL_DISK_QUOTA_MB`.

`Repl = {id, name, description, template, language, is_public, owner: {id, username, display_name}, role: "owner"|"editor"|"viewer", forked_from, created_at, updated_at, config: {run, entrypoint, gui, port}}`

**Runtime**
- `POST /repls/{id}/start` → `{status: "running", stopped: string[]}` (editor+). `stopped` lists the caller's repls stopped to stay under `MAX_RUNNING_PER_USER`; 503 when the server is at `MAX_RUNNING_REPLS`, 507 when the repl is over its disk quota.
- `POST /repls/{id}/stop` → `{status: "stopped"}` (editor+)
- `GET /repls/{id}/status` → `{status: "running"|"stopped"|"missing"}`
- `GET /repls/{id}/ports` → `{ports: number[], preview_base: "http://{id}-{port}.preview.localhost:8380"}`
  (preview URL template; the frontend substitutes `{port}`)

**Files** (paths are relative, POSIX, validated to stay inside the repl; `.git` hidden)
- `GET /repls/{id}/files` → `FileNode[]` flat list `{path, type: "file"|"dir", size}`,
  sorted, skipping `.git` and not descending into `node_modules`, `__pycache__`, `target`, `.venv`, `bin/obj`.
- `GET /repls/{id}/files/content?path=` → `{path, content, encoding: "utf-8"|"base64"}`
- `PUT /repls/{id}/files/content {path, content}` → `{path, size}` (editor+)
- `POST /repls/{id}/files {path, type}` → create a file or directory (editor+)
- `POST /repls/{id}/files/rename {from, to}` (editor+)
- `DELETE /repls/{id}/files?path=` (editor+)
- `POST /repls/{id}/files/upload` multipart `file`, `dir` (editor+)
- `GET /repls/{id}/download` → zip, built in a temp file and streamed (413 past `MAX_ZIP_MB` uncompressed)

File reads return 413 past `MAX_FILE_READ_MB`; uploads return 413 past `MAX_UPLOAD_MB` or when the repl
would exceed `REPL_DISK_QUOTA_MB`. Diff and show output is truncated past `MAX_GIT_OUTPUT_MB`. Commits are
authored as `<username>@users.noreply.repl`.

**Git**
- `GET /repls/{id}/git/status` → `{branch, changes: [{path, status}]}`
- `GET /repls/{id}/git/log?limit=50` → `[{sha, short_sha, message, author_name, author_email, date}]`
- `POST /repls/{id}/git/commit {message}` → commit (stages everything; editor+)
- `GET /repls/{id}/git/diff?sha=` → `{diff}` (unified; the commit's diff, or working tree vs HEAD if no sha)
- `GET /repls/{id}/git/show?sha=&path=` → `{content}` (file at a commit)
- `POST /repls/{id}/git/restore {sha, path?}` → check out the tree (or one path) from `sha`, then commit "Restore to {short}" (editor+)

**Sharing**
- `GET /repls/{id}/collaborators` → `[{user: {id, username, display_name}, role}]` (no emails)
- `POST /repls/{id}/collaborators {username, role}` (owner)
- `DELETE /repls/{id}/collaborators/{user_id}` (owner)

**Internal** (not routed by nginx except `auth-repl` as an internal subrequest)
- `GET /internal/auth-repl` with headers `X-Repl-Id` and `X-Repl-Service: run|shell|vnc|lsp` and the
  user's cookie → 204 if allowed (`run` needs viewer, `shell`/`vnc`/`lsp` need editor), 401/403 otherwise. The 204 carries `X-Repl-Role` and the repl's `X-Agent-Token` for nginx to forward.
- `GET /internal/collab-auth?repl_id=&path=` + the user's cookie → `{user_id, username, read_only}` | 401/403
- `GET /internal/files/content?repl_id=&path=` (header `X-Internal-Secret`) → `{content}`
- `PUT /internal/files/content {repl_id, path, content}` (header `X-Internal-Secret`)

## 7. Real-time collaboration

Each open file is a Hocuspocus document named `{replId}::{path}` holding one
`Y.Text("content")`. `onAuthenticate` forwards the WS upgrade's `Cookie` to
`/internal/collab-auth`. Viewers connect read-only. `onLoadDocument` seeds the
Y.Text from the file on disk if the doc is empty. `onStoreDocument` (debounced
1 s, max 5 s) writes the text back through `/internal/files/content`. Disk
stays the source of truth: when the last client leaves, the room unloads, and
the next open reloads from disk, which picks up anything the user changed
from the shell.

Some operations change files outside the editor: git restore, rename, delete,
upload, and REST saves. After each one the backend calls
`POST collaboration:1235/reload {repl_id}` (shared-secret header). The
collaboration server re-reads every open room of that repl from disk. Text
that changed is replaced in a single Yjs transaction, so connected editors
update live. Rooms whose file is gone are closed, and their pending stores are
dropped so they can't bring the file back.

Files can also change while nobody touches the API: an edit in the shell, a
program rewriting its own source, `git checkout` in the terminal. For those
the collaboration server polls each open room's file every 2 s. When the disk
copy has moved since the last load or store and the room has no unsaved edits,
the room takes the disk text. When the room does have unsaved edits, the
editors win and their next store overwrites the disk copy.

The frontend binds Monaco with `y-monaco` and shows remote cursors with
awareness (name and color). If the collaboration socket cannot connect within 3 s,
the editor falls back to plain REST saves (debounced 800 ms, and on Ctrl+S).

## 8. Frontend

React 18, Vite, TypeScript, Tailwind v4, shadcn/ui (new-york, neutral),
lucide icons, zustand, react-router, react-resizable-panels, Monaco, xterm.js,
plus y-monaco and @hocuspocus/provider. The stack is the same as PlottedPlant's.

Routes:
- `/`: landing page with a hero and a language grid.
- `/login`, `/register`
- `/dashboard`: "My repls" and "Shared with me" card grids, plus a **Create repl** dialog
  with a searchable template picker grouped by category.
- `/explore`: public repls.
- `/repl/:id`: the workspace.

Workspace layout (resizable panels):
```
┌ top bar: ← | repl name (rename) | [▶ Run / ■ Stop] | status | Fork | Share | user ┐
├ sidebar ──────┬ editor tabs ───────────────────┬ tools (tabs) ─────────────────┤
│ Files (tree,  │ Monaco + yjs, per-file tabs,    │ Console (xterm on /run)       │
│ new/rename/   │ language by extension,          │ Shell (xterm on /shell)       │
│ delete/upload)│ remote cursors                  │ Webview (iframe + port picker │
│ Version       │                                 │   + open in new tab)          │
│ control (git) │                                 │ Display (noVNC iframe)        │
└───────────────┴─────────────────────────────────┴───────────────────────────────┘
```
Run auto-focuses the Console. When a new port starts listening, the Webview
tab opens. For `gui = true` templates, Run focuses Display.

### Intellisense (language servers)

Every language gets a real language server inside the repl's container.

- **Bridge:** the agent serves `WS /lsp/{server}`. Each connection starts one
  server from its spec in `runner/agent/lsp/*.json`, and each WebSocket frame
  carries one JSON-RPC message.
- **Routing:** nginx routes `/ws/repls/{id}/lsp/{server}` behind
  `auth_request`, and only editors may connect, because servers run project
  code such as build scripts.
- **Client:** the frontend's own LSP client in `frontend/src/lib/lsp/` drives
  Monaco's completion, hover, signature help, diagnostics, definitions,
  references, rename, formatting and code actions.
- **Installation:** installers live in `runner/lsp-install/*.sh`, and
  `runner/agent/lsp_test.py` is the end-to-end check every server must pass.

**Memory safety.** Language servers are large JVM, .NET and Node processes,
and one of them, JetBrains' Kotlin LSP 263.x, has run away. During its
build-time index warm-up it once grew to about 30 GB of native memory in 3
minutes, despite `-Xmx3g`. `docker build` steps have no memory limit and run
with `oom_score_adj` -500, so the host OOM killer took down the desktop
session instead of the build. A second run aborted natively after a heap OOM
at 1 GB. Five capped reruns finished normally at a 2.5–2.9 GB peak, so the
runaway is intermittent and its trigger is unknown. The defenses are layered:

1. **No heavy work inside `docker build`.** `runner/build.sh`, which
   `make runner` calls, builds the image, then pre-builds the Kotlin index in
   a throwaway container. That container has `--memory=4g --memory-swap=4g`,
   so it gets no swap, plus `--oom-score-adj=1000` and a 300 s hard timeout.
   `runner/kotlin-index/warm.sh` also kills the warm-up at 3.5 GB RSS. The
   index is layered into the image only on success. Otherwise the image ships
   without it, and Kotlin indexes on first open.
2. **Per-server memory limit in the bridge.** Each server's process group is
   polled every 2 s for its *anonymous* memory (smaps `Anonymous:`). Plain
   RSS would also count mmap'd jars and kotlin-lsp's index, which are
   reclaimable page cache; under gVisor that put a healthy Kotlin server at
   1.9 GB "RSS" (0.8 GB anonymous). Past `maxMemoryMB` (default 1024; jdtls
   1200, kotlin 1300; normal peaks are 0.03–0.83 GB) the group is killed and
   the user sees a message. The server is then
   refused with HTTP 503 for 5 minutes, and the editor stops reconnecting.
3. **Repl containers are hard-capped:** 2 GB with no swap
   (`memswap_limit` = `mem_limit`). They also run with `oom_score_adj` 800, so
   a host-wide OOM picks a repl before anything else on the machine.

## 9. Security notes

- User code runs in containers as uid 1000 with no capabilities,
  `no-new-privileges`, and memory, CPU, pid, `/tmp` and log limits (§5). The
  image has no `sudo`. Repls run under gVisor (`REPL_RUNTIME=runsc`, the
  default), so user code talks to gVisor's user-space kernel, not the host's:
  a runc escape would reach a host with the Docker socket mounted in the
  backend. The backend refuses to start with `runc` when `APP_ENV=production`
  unless `ALLOW_INSECURE_RUNTIME=true`.
- Each repl has its own bridge network (§5). Repls can reach the internet (for
  `pip install` and `npm install`) but not each other, and not postgres, which
  sits on `rc-internal`.
- The agent requires a per-repl token on every request (§5), so reaching
  `:8008` on a repl's network is not enough to get a shell. noVNC and VNC
  listen on the container's loopback only and are reached through the agent.
- The preview proxy accepts only canonical ports 1-65535 (no leading zeros:
  `-08008` used to reach the agent) and refuses 8008, 6080 and 5900. It
  strips `Cookie`, `X-Agent-Token` and `X-Repl-Role` from what it forwards;
  the `/ws/repls` routes strip `Cookie` too.
- nginx rate-limits per client address: login/register 10/min (burst 10),
  the rest of `/api` 20/s (burst 40), and at most 50 concurrent `/ws`
  connections. The app sends `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin` and
  `Content-Security-Policy: frame-ancestors 'self'`.
- Previews are a different *origin* from the app but the same *site*, so
  SameSite=Lax cookies are still sent from preview pages. nginx therefore
  refuses any request to the app whose `Origin` is a preview host.
- The console auth subrequest parses the raw URI, while `proxy_pass` uses the
  normalized one. nginx refuses `/ws/` URIs containing dot segments or encoded
  separators, so the two can never name different repls.
- nginx passes the caller's role (`X-Repl-Role`, from the auth subrequest) to
  the agent. Viewers can watch the console of a public repl, but the agent
  drops their start, stop, and stdin.
- **git never runs in the backend.** Repl users have a shell next to `.git`,
  so `.git/config` and `.gitattributes` are attacker-controlled:
  `core.fsmonitor`, hooks, and filter drivers can all run commands. The
  backend holds the Docker socket and sits on every repl's network, so git
  runs in the repl's own sandbox: `docker exec` as uid 1000 in the repl's
  container when it is running, otherwise a throwaway container from the
  runner image (`--network none`, uid 1000, read-only root, 512 MB / 128 pids
  / 1 CPU, only the repl directory mounted) that lives for one API call. git
  still gets a throwaway `HOME`, no system or global config, and
  `core.fsmonitor`, `core.hooksPath`, `diff.external` and the credential
  helper forced off. Verified: a malicious `filter.x.clean` runs inside the
  repl's container or the throwaway one, with no network.
- File API paths are resolved and checked against the repl root (no `..`, no
  symlink escape). Reads and writes then walk the path one component at a
  time with `openat` + `O_NOFOLLOW`. Without that, a user could swap a
  directory for a symlink between the check and the backend's root `open` and
  read something like `/proc/self/environ`. Create, rename, and delete use
  the same walk with `mkdirat`, `renameat`, `unlinkat`, and fd-based `rmtree`.
- Previews are served on a different origin (`*.preview.localhost`), so user
  JavaScript cannot read the auth cookie (it is httpOnly anyway). See the
  Origin check above for requests that carry the cookie.

- Startup refuses placeholder or short (< 32 chars) `JWT_SECRET_KEY` /
  `INTERNAL_SECRET`, and in production a placeholder database password.
- The API docs (`/api/v1/docs`, `openapi.json`) are served only with
  `APP_ENV=development`. CORS is off unless `CORS_ORIGINS` is set.
- Rate limits key on the client IP; `X-Forwarded-For` is believed only from
  `TRUSTED_PROXIES` (default: the nginx container), read right to left.

## 10. Templates

Templates live in `backend/app/templates_data/{slug}/` (files plus `.replit`)
and are registered in `backend/app/templates_data/index.json`.

| Category | Templates |
|---|---|
| language | python, nodejs, typescript, java, kotlin, c, cpp, csharp, go, rust, ruby, php-cli, lua, perl, bash, haskell, r, fortran, pascal, nasm, scheme, common-lisp |
| static | html-css-js |
| web | flask, fastapi, express, php-web, django, spring-boot, go-http |
| framework | react-vite, vue-vite |
| gui | python-tkinter, java-swing, pygame |

## 11. Repository layout

```
backend/        FastAPI app (app/main.py, routers/, models/, services/, templates_data/)
collaboration/  Hocuspocus server
frontend/       React SPA
nginx/          nginx.conf, Dockerfile (multi-stage: builds the SPA)
runner/         polyglot image + in-container agent
docs/           this document
docker-compose.yml
```

## 12. Running it

```
cp .env.example .env
docker build -t repl-polyglot:latest runner/      # or: make runner
make versions                                      # print toolchain versions
docker compose up -d --build
open http://localhost:8380
```

Production behind a host TLS proxy (Caddy, on-demand preview certificates,
gVisor, a capped systemd slice, backups): [DEPLOY.md](DEPLOY.md).

## 13. Future work

Packager UI (pip/npm search); GitHub import and push;
always-on repls; debugger (DAP) integration; multi-host scheduling with a
container pool for instant start.

---

## 14. Implementation status (2026-10-05)

Built in one evening by a lead plus three parallel agents, each in its own git
worktree and PR:

| PR | Scope |
|---|---|
| #1 | Infra: nginx, Hocuspocus, compose |
| #2 | Backend |
| #3 | Runner agent and 35 templates |
| #4 | Frontend |
| #5 | Fixes from end-to-end browser testing |
| #6 | Collaboration rooms reload from disk after restore, rename, delete and upload |
| #9–#11 | Security hardening: git runs as the repl uid; file operations use `openat` + `O_NOFOLLOW` |
| #12 | Open rooms pick up edits made from the shell |
| #15, #16 | Review fixes: symlink and FIFO races in zip, fork and chown; a diff that no longer touches the index; agent backpressure |
| #17 | Per-repl /28 subnets from a dedicated pool; stopping a repl frees its container and network |
| #14 | Gateway hardening from a code review: per-repl networks, preview port blocklist, Origin and dot-segment checks, viewer-only console |

The section 6 API was the contract between them. Integration needed only
small fixes.

### Verified end to end (through nginx, in Chrome and with `scripts/smoke_test.py`)

- Register and log in. Create a repl from a template, which starts its
  container. Open the Console and press Run to stream output. Use the Shell.
- **GUI:** Tkinter renders in the Display tab (noVNC) and is interactive.
- **Web preview:** Flask is served at `{id}-8000.preview.localhost:8380` in the
  Webview, which switches automatically when a new port opens.
- **Multiplayer:** a second user, shared as editor, edited `main.py` over Yjs
  from a Node client. The edit appeared live in the first user's Monaco and was
  saved to disk.
- **Git:** typing in the editor marks the file modified. A commit from the
  Version control panel shows up in the history.
- **Permissions:**
  - Outsiders get 404 on the repl.
  - VNC returns 401 with no cookie and 403 for a non-collaborator.
  - Internal endpoints are not reachable through nginx.
- **Templates:** these runs exited 0 or bound their port:
  - **Languages:** C, C++, Go, Rust, Kotlin, Haskell, TypeScript, PHP, Lua,
    Perl, Bash.
  - **Web servers:** Flask, FastAPI, Django, Express, PHP, Go net/http, static
    HTML.
  - **Frameworks:** React + Vite, Vue + Vite, Spring Boot. These install
    dependencies on first run.
  - **Not covered by the smoke script:** Python, Node.js, Java, C# and Ruby
    wait for stdin, so they time out there. The runtime PR tested them
    separately, piping input in.

### Decisions made while building

- **Agent vs. `docker exec`.** The plan was to try both. A shared run process
  with scrollback, multiple viewers, and port discovery all need state that
  lives in the container, which `docker exec` relayed by the backend cannot
  hold, so the agent was picked before writing the exec version.
- **Ports bound to loopback are not offered as previews.** Docker's embedded
  DNS listens on `127.0.0.11` inside every container, and the first build
  offered it as a "web server". The preview proxy can't reach loopback-bound
  servers anyway.
- **noVNC uses `resize=scale`.** Xvfb has a fixed framebuffer, so remote resize
  does nothing.
- **Restore deletes files added after the target commit.** The working tree
  then matches the commit exactly, which is what users expect from "restore to
  this version".

### Known gaps

- No resource quotas per user, and no gVisor yet (§9).
