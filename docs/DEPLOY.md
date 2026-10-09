# Deploying Repl on a shared VPS

This is how https://repl.arelyx.xyz runs: one VPS that also hosts other
projects behind a host-wide Caddy. Repl binds a single loopback port, Caddy
terminates TLS and routes by hostname, and every repl container runs under
gVisor inside a systemd slice capped well below the machine's size.

```
Internet ─► Caddy (host, :443) ─┬─ repl.arelyx.xyz            ─► 127.0.0.1:8390 (repl-nginx)
                                └─ *.preview.repl.arelyx.xyz  ─► 127.0.0.1:8390 (on-demand TLS)
repl-nginx ─► backend, collaboration, repl-<id> containers (runsc, repl-containers.slice)
```

## 1. DNS

| Record | Type | Value |
|---|---|---|
| `repl.arelyx.xyz` | A | the VPS address |
| `*.preview.repl.arelyx.xyz` | A | the same address (web previews) |

Previews live on their own hostnames (`<repl>-<port>.preview.<host>`), so
user JavaScript never runs on the app's origin.

## 2. Host (once, as root)

1. Docker with the gVisor runtime. Install `runsc` from
   `https://storage.googleapis.com/gvisor/releases` and register it in
   `/etc/docker/daemon.json`:

   ```json
   { "runtimes": { "runsc": { "path": "/usr/bin/runsc", "runtimeArgs": ["--systemd-cgroup"] } } }
   ```

   `kill -HUP $(pidof dockerd)` loads it without restarting any container.
2. `deploy/install-host.sh` installs the egress firewall (`REPL-EGRESS`, only
   for `10.213.0.0/16`), the kernel-module blocklist, and
   `repl-containers.slice`. On a shared host, reserve most of the machine for
   the other tenants, e.g. on 8 cores / 22 GB:

   ```sh
   sudo RESERVED_CORES=4 RESERVED_MB=14336 deploy/install-host.sh   # repls: 4 cores, 8 GB
   ```

   The slice also has half the CPU weight of `system.slice`, so under
   contention repls yield to every other service.

## 3. App

```sh
git clone https://github.com/arelyx/repl.git ~/repl && cd ~/repl
cp .env.example .env    # then edit, see below
docker load < repl-polyglot.tar.zst   # or: make runner (about an hour on 8 cores)
docker compose up -d --build
```

`.env` for this deployment (secrets: `openssl rand -hex 32` each):

```sh
POSTGRES_USER=repl
POSTGRES_PASSWORD=<random>
POSTGRES_DB=repl
JWT_SECRET_KEY=<random>
INTERNAL_SECRET=<random>
REPLS_HOST_DIR=/home/arelyx/repl/data/repls
PUBLIC_HOST=repl.arelyx.xyz
PUBLIC_SCHEME=https
PREVIEW_HOST=repl.arelyx.xyz
HTTP_PORT=8390
APP_ENV=production
REPL_RUNTIME=runsc
MAX_RUNNING_REPLS=8        # 8 GB slice / ~0.7 GB per active repl, 2 GB cap each
MAX_RUNNING_PER_USER=2
PREVIEW_CERTS_PER_WEEK=30  # Let's Encrypt: 50 new certs/week for all of arelyx.xyz
```

## 4. Caddy

Add the blocks from `deploy/Caddyfile.example` to `/etc/caddy/Caddyfile`
(the global `on_demand_tls` block goes first), then:

```sh
sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-repl-$(date +%F)
caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

`repl.arelyx.xyz` gets a normal certificate. Preview hostnames get one each,
on first visit, after Caddy asks the backend (`/tls-ask`, host-local only)
whether that repl exists. The backend refuses new hostnames past
`PREVIEW_CERTS_PER_WEEK` so previews can't use up the registered domain's
Let's Encrypt allowance; already-approved hostnames keep renewing. A wildcard
certificate (DNS-01, needs the DNS provider's API) removes the limit: set
`PREVIEW_CERTS_PER_WEEK=-1` then.

## 5. Backups

`deploy/backup.sh` (cron, nightly) writes a `pg_dump` and a tarball of
`data/repls` to `~/repl/backups`, keeping 14 dailies and 12 monthlies.

```
45 3 * * * $HOME/repl/deploy/backup.sh >> $HOME/repl/backups/backup.log 2>&1
```

## Updating

```sh
cd ~/repl && git pull && docker compose up -d --build
```

A new runner image affects repls started after it loads; running ones keep
the old image until they stop (idle timeout 30 min, hard limit 12 h).
