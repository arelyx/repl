# Replit Clone ("Replot") — Design Document

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
backend ──docker.sock──▶ Docker Engine ──▶ repl-{id} containers (image replit-polyglot)
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
| `repl-{id}` | `replit-polyglot` image | One per running repl. Runs the in-container agent, Xvfb + fluxbox + x11vnc + websockify (noVNC), and user code. |

### Why these choices

- **One fat "polyglot" image** (like Replit's polygott) instead of an image per
  language. Templates can mix languages (a Flask backend with a React
  frontend), switching language does not need a new container, and there is
  only one image to build and cache. The cost is a large image (~6 GB), paid once.
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

- Image: `replit-polyglot:latest` (`runner/Dockerfile`).
- Container name `repl-{id}`, network `rc-repls`, labels `replot.repl={id}`.
- Mount `${REPLS_HOST_DIR}/{id}` → `/home/runner/app`.
- Limits: `mem_limit=2g`, `nano_cpus=2e9`, `pids_limit=1024`, `cap_drop=ALL`
  (only `CHOWN`, `SETUID`, `SETGID`, `DAC_OVERRIDE` are added back),
  `security_opt=no-new-privileges`.
- Entrypoint (`/opt/replagent/entrypoint.sh`) starts Xvfb `:0` (960x600),
  fluxbox, x11vnc (`-forever -shared -nopw`, localhost only), websockify `:6080`
  serving `/usr/share/novnc`, then the agent on `:8008`.
- Lifecycle: `POST /repls/{id}/start` creates or starts the container and waits
  until the agent's `/health` answers. Opening a repl calls start. A reaper
  stops containers idle for more than `IDLE_TIMEOUT_MINUTES` (default 30) with no
  agent WebSocket clients.

### Agent protocol (port 8008)

| Endpoint | Purpose |
|---|---|
| `GET /health` | `{"ok":true}` |
| `GET /ports` | `{"ports":[3000,8000]}`: TCP ports listening on any interface, excluding 8008/6080/5900. |
| `WS /run` | Attach to the single shared Run process. |
| `WS /shell` | A fresh `bash -l` PTY per connection. |

WebSocket messages are JSON text frames:

- client → agent: `{"type":"input","data":"..."}`, `{"type":"resize","cols":80,"rows":24}`,
  `/run` only: `{"type":"start"}` (kill any current run, re-read `.replit`, start `run`),
  `{"type":"stop"}`.
- agent → client: `{"type":"output","data":"..."}`,
  `/run` only: `{"type":"status","running":true|false,"exitCode":int|null,"command":"..."}`
  (sent on connect and on every change). On connect to `/run` the agent first replays
  up to 256 KB of scrollback.

## 6. HTTP API (`/api/v1`)

Auth cookie: `access_token` (httpOnly, SameSite=Lax, JWT HS256, 7 days).
Errors: `{"detail": "..."}` with the usual status codes.

**Auth**
- `POST /auth/register {email, username, password, display_name?}` → `User` and sets the cookie
- `POST /auth/login {login, password}` (`login` = email or username) → `User` and sets the cookie
- `POST /auth/logout` → 204
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

`Repl = {id, name, description, template, language, is_public, owner: {id, username, display_name}, role: "owner"|"editor"|"viewer", forked_from, created_at, updated_at, config: {run, entrypoint, gui, port}}`

**Runtime**
- `POST /repls/{id}/start` → `{status: "running"}` (editor+)
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
- `GET /repls/{id}/download` → zip

**Git**
- `GET /repls/{id}/git/status` → `{branch, changes: [{path, status}]}`
- `GET /repls/{id}/git/log?limit=50` → `[{sha, short_sha, message, author_name, author_email, date}]`
- `POST /repls/{id}/git/commit {message}` → commit (stages everything; editor+)
- `GET /repls/{id}/git/diff?sha=` → `{diff}` (unified; the commit's diff, or working tree vs HEAD if no sha)
- `GET /repls/{id}/git/show?sha=&path=` → `{content}` (file at a commit)
- `POST /repls/{id}/git/restore {sha, path?}` → check out the tree (or one path) from `sha`, then commit "Restore to {short}" (editor+)

**Sharing**
- `GET /repls/{id}/collaborators` → `[{user: User, role}]`
- `POST /repls/{id}/collaborators {username, role}` (owner)
- `DELETE /repls/{id}/collaborators/{user_id}` (owner)

**Internal** (not routed by nginx except `auth-repl` as an internal subrequest)
- `GET /internal/auth-repl` with headers `X-Repl-Id` and `X-Repl-Service: run|shell|vnc` and the
  user's cookie → 204 if allowed (`run` needs viewer, `shell`/`vnc` need editor), 401/403 otherwise.
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

## 9. Security notes

- User code runs in containers as uid 1000 with dropped capabilities,
  `no-new-privileges`, and memory, CPU, and pid limits. This is not a hard
  sandbox: anyone who can break out of runc reaches a host with the Docker
  socket mounted in the backend. Production should use gVisor (`--runtime=runsc`),
  which is a single config switch (`REPL_RUNTIME`).
- Repl containers sit on their own `rc-repls` bridge network. They can reach
  the internet (for `pip install` and `npm install`) but not postgres, which
  sits on `rc-internal`.
- **git never runs as root.** Repl users have a shell next to `.git`, so
  `.git/config` and `.gitattributes` are attacker-controlled: `core.fsmonitor`,
  hooks, and filter drivers can all run commands. The backend holds the Docker
  socket, so it runs git as uid 1000 with no supplementary groups (and so no
  docker group). It also uses a throwaway `HOME`, no system or global config,
  and forces `core.fsmonitor`, `core.hooksPath`, `diff.external` and the
  credential helper off. Verified: a malicious `filter.x.clean` runs as
  `uid=1000`, and that uid can neither open `docker.sock` nor read the
  backend's environment.
- File API paths are resolved and checked against the repl root (no `..`, no
  symlink escape). Reads and writes then walk the path one component at a
  time with `openat` + `O_NOFOLLOW`. Without that, a user could swap a
  directory for a symlink between the check and the backend's root `open` and
  read something like `/proc/self/environ`. Create, rename, and delete use
  the same walk with `mkdirat`, `renameat`, `unlinkat`, and fd-based `rmtree`.
- Previews are served on a different origin (`*.preview.localhost`) from the
  app, so user JavaScript cannot read the auth cookie or call the API with it.

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
docker build -t replit-polyglot:latest runner/
docker compose up -d --build
open http://localhost:8380
```

## 13. Future work

gVisor runtime; per-user quotas; packager UI (pip/npm search); LSP
(PlottedPlant already runs an LSP container); GitHub import and push;
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
