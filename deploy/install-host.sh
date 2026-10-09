#!/bin/bash
# Host setup for a Repl server. Idempotent; run as root from the repo root
# after Docker and gVisor (runsc) are installed:
#
#   sudo deploy/install-host.sh
#
# Installs the repl egress firewall, the kernel-module blocklist, and the
# repl-containers.slice parent cgroup sized from this host's cores and RAM, and
# checks the rest of what production expects (runsc runtime, systemd-oomd,
# no swap for repls).
set -euo pipefail
cd "$(dirname "$0")"

# Cores and memory kept back for the OS, Docker, nginx, the backend,
# postgres and collaboration (~250 MB measured, 2.75 GB of limits).
RESERVED_CORES=${RESERVED_CORES:-4}
RESERVED_MB=${RESERVED_MB:-6144}

cores=$(nproc)
mem_mb=$(awk '/^MemTotal:/ {print int($2 / 1024)}' /proc/meminfo)
repl_cores=$(( cores > RESERVED_CORES + 1 ? cores - RESERVED_CORES : 1 ))
repl_mb=$(( mem_mb > RESERVED_MB + 2048 ? mem_mb - RESERVED_MB : 2048 ))
# MemoryHigh starts reclaim (page cache first) a little before MemoryMax.
high_mb=$(( repl_mb * 95 / 100 ))

install -d /opt/repl
install -m 0755 firewall.sh /opt/repl/firewall.sh
install -m 0644 repl-firewall.service /etc/systemd/system/
install -m 0644 modprobe-repl.conf /etc/modprobe.d/repl-hardening.conf
sed -e "s/^CPUQuota=.*/CPUQuota=$(( repl_cores * 100 ))%/" \
    -e "s/^MemoryMax=.*/MemoryMax=${repl_mb}M/" \
    -e "s/^MemoryHigh=.*/MemoryHigh=${high_mb}M/" \
    -e "s/(32 cores, 29 GB)/(${cores} cores, $(( mem_mb / 1024 )) GB)/" \
    repl-containers.slice > /etc/systemd/system/repl-containers.slice

systemctl daemon-reload
systemctl enable --now repl-firewall.service
systemctl start repl-containers.slice
# Unload anything the blocklist names that is already loaded.
for m in algif_aead esp4 esp6 af_rxrpc rxrpc; do modprobe -r "$m" 2>/dev/null || true; done

echo "repl-containers.slice: CPUQuota=$(( repl_cores * 100 ))% MemoryMax=${repl_mb}M" \
     "(host: ${cores} cores, ${mem_mb} MB; reserved ${RESERVED_CORES} cores, ${RESERVED_MB} MB)"

warn=0
if ! docker info --format '{{json .Runtimes}}' | grep -q '"runsc"'; then
  echo "WARNING: Docker has no 'runsc' runtime; repls will not start with REPL_RUNTIME=runsc." >&2
  warn=1
fi
if ! systemctl is-active --quiet systemd-oomd; then
  echo "WARNING: systemd-oomd is not running (apt install systemd-oomd)." >&2
  warn=1
fi
if [ "$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo)" != 0 ]; then
  echo "note: host swap is on. Repls get none (MemorySwapMax=0, memswap = mem)," \
       "but keep it small so the platform services stay responsive." >&2
fi
exit $warn
