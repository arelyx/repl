#!/bin/bash
# Pre-build the Kotlin LSP index. Runs as root inside a throwaway, memory-capped
# container started by runner/build.sh, never inside `docker build`.
# Writes the index to $1/index-seed. Exits non-zero if the warm-up fails or is
# killed by the watchdog; the caller then ships the image without an index.
set -euo pipefail
out=$1
dir=/opt/lsp/kotlin-lsp
LIMIT_MB=${WARMUP_RSS_LIMIT_MB:-3500}
TIMEOUT=${WARMUP_TIMEOUT:-300}

# Throwaway container: give the warm-up a 2 GB heap (1 GB has run out).
sed -i 's/^-Xmx.*/-Xmx2g/' "$dir/bin/intellij-server.vmoptions"

scratch=$(mktemp -d)
mkdir -p "$scratch/project" "$scratch/home"
cp "$dir/workspace.json" "$scratch/project/"
printf 'fun main() {\n    println("warm-up")\n}\n' > "$scratch/project/main.kt"
seed="$out/index-seed"
rm -rf "$seed"

HOME="$scratch/home" TMPDIR="$scratch" timeout -s KILL "$TIMEOUT" \
  python3 "$dir/bin/warmup.py" --build-tool json --timeout $((TIMEOUT - 20)) \
  "$scratch/project" "$seed" > "$scratch/warmup.log" 2>&1 &
pid=$!

# Watchdog, in addition to the container's cgroup cap: kill the warm-up if
# resident memory passes LIMIT_MB, so a runaway ends with a clear message
# instead of an OOM kill.
# The container holds nothing else, so its total RSS is the warm-up's.
tree_rss_mb() { ps -eo rss= | awk '{t+=$1} END {print int(t/1024)}'; }
peak=0
while kill -0 "$pid" 2>/dev/null; do
  rss=$(tree_rss_mb)
  (( rss > peak )) && peak=$rss
  if (( rss > LIMIT_MB )); then
    echo "kotlin-index: warm-up reached ${rss} MB (limit ${LIMIT_MB} MB); killing it" >&2
    pkill -KILL -f "$dir/bin/" || true
    kill -KILL "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    exit 3
  fi
  sleep 1
done
wait "$pid" || true
echo "kotlin-index: peak ${peak} MB"

# warmup.py exits non-zero when the server needs killing after shutdown, so
# judge success by the ready notification instead.
if ! grep -q 'intellij/ready-for-test' "$scratch/warmup.log"; then
  echo "kotlin-index: warm-up did not finish" >&2
  tail -n 30 "$scratch/warmup.log" >&2
  exit 1
fi
rm -rf "$seed/.app.lock" "$seed/system/log"
test -d "$seed/rocks"
chmod -R a+rX "$seed"
