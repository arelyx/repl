#!/bin/bash
# Build the runner image: `make runner` calls this.
#
#   1. docker build the toolchains + language servers (no heavyweight steps).
#   2. Pre-build the Kotlin LSP index in a throwaway container with a hard
#      memory cap and no swap, so a runaway can only kill itself.
#   3. Layer the index in. If step 2 fails, ship the image without it
#      (Kotlin then indexes on first open inside the 2 GB repl container).
set -euo pipefail
cd "$(dirname "$0")"
TAG=${1:-replit-polyglot:latest}
STAGE=replit-polyglot:stage

docker build -t "$STAGE" .

work=$(mktemp -d)
trap 'docker run --rm -v "$work":/w alpine rm -rf /w/index-seed >/dev/null 2>&1; rm -rf "$work"' EXIT
if docker run --rm --user root --entrypoint bash \
     --memory=4g --memory-swap=4g --oom-score-adj=1000 --cpus=4 --pids-limit=2048 \
     -v "$PWD/kotlin-index/warm.sh:/warm.sh:ro" -v "$work:/out" \
     "$STAGE" /warm.sh /out; then
  docker build -t "$TAG" --build-arg BASE="$STAGE" -f kotlin-index/Dockerfile "$work"
else
  echo "build.sh: Kotlin index warm-up failed; building without a pre-built index" >&2
  docker tag "$STAGE" "$TAG"
fi
docker run --rm --entrypoint replot-versions "$TAG" >/dev/null && echo "build.sh: $TAG ready"
