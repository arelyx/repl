#!/usr/bin/env bash
# Nightly backup of a Repl deployment, run on the host from cron:
#   45 3 * * * $HOME/repl/deploy/backup.sh >> $HOME/repl/backups/backup.log 2>&1
# Writes $DEST/repl-<UTC stamp>.dump (pg_dump custom format; the newest $KEEP
# plus the first of each month for $KEEP_MONTHLY months) and
# $DEST/repls-<stamp>.tar.gz of the repl working trees (newest $KEEP_FILES).
# Rotation counts files rather than using mtime, so failed nights never empty
# the directory. Restore: pg_restore -c into the postgres container, untar
# into REPLS_HOST_DIR.
set -euo pipefail
cd "$(dirname "$0")/.."
DEST=${DEST:-$PWD/backups}
KEEP=${KEEP:-14}
KEEP_MONTHLY=${KEEP_MONTHLY:-12}
KEEP_FILES=${KEEP_FILES:-3}
set -a; . ./.env; set +a

umask 077
mkdir -p "$DEST/monthly"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

OUT="$DEST/repl-$STAMP.dump"
docker exec repl-postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -Z 6 > "$OUT.part"
# a dump that pg_restore cannot list is not a backup
docker exec -i repl-postgres pg_restore -l < "$OUT.part" > /dev/null
mv "$OUT.part" "$OUT"

# Repl files belong to the containers' uid 1000, which need not be this
# user; the backend mounts the tree at the same path and runs as root.
FILES="$DEST/repls-$STAMP.tar.gz"
docker exec repl-backend tar -C "$(dirname "$REPLS_HOST_DIR")" -czf - "$(basename "$REPLS_HOST_DIR")" > "$FILES.part"
mv "$FILES.part" "$FILES"
cp -p .env "$DEST/repl.env"

MONTH=$(date -u +%Y%m)
ls "$DEST/monthly/repl-$MONTH"*.dump > /dev/null 2>&1 || cp -p "$OUT" "$DEST/monthly/"
ls -1t "$DEST"/repl-*.dump | tail -n +$((KEEP + 1)) | xargs -r rm -f --
ls -1t "$DEST"/monthly/repl-*.dump | tail -n +$((KEEP_MONTHLY + 1)) | xargs -r rm -f --
ls -1t "$DEST"/repls-*.tar.gz | tail -n +$((KEEP_FILES + 1)) | xargs -r rm -f --
rm -f "$DEST"/*.part

echo "$(date -u +%FT%TZ) ok $OUT $(du -h "$OUT" | cut -f1), $FILES $(du -h "$FILES" | cut -f1)"
