#!/bin/sh
# Starts Nook in the Docker image (lane BACKUP, D615; the image's CMD).
#
# LITESTREAM_ENABLED=true with an S3 bucket (STORAGE_BACKEND=s3, S3_BUCKET, or BACKUP_S3_BUCKET):
#   server/litestream.ts writes the replica's settings to /tmp/litestream.yml (no credentials) and prints
#   the credentials as exports for Litestream's own environment; then Litestream supervises the server
#   (`litestream replicate -exec "bun server/index.ts"`): it forwards SIGTERM, and exits when Nook exits.
# Otherwise (the default, no bucket, or no binary): `bun server/index.ts`, as before.
#
# NOOK_START_DRY_RUN=1 prints the command instead of running it (tests).
set -eu
cd "$(dirname "$0")/.."

BUN="${NOOK_BUN:-bun}"
LITESTREAM="${LITESTREAM_BIN:-litestream}"
CONFIG="${LITESTREAM_CONFIG:-/tmp/litestream.yml}"

run() {
  if [ "${NOOK_START_DRY_RUN:-}" = "1" ]; then
    printf '%s\n' "$*"
    exit 0
  fi
  exec "$@"
}

case "$(printf '%s' "${LITESTREAM_ENABLED:-false}" | tr '[:upper:]' '[:lower:]')" in
  true) ;;
  *) run "$BUN" server/index.ts ;;
esac

if ! command -v "$LITESTREAM" >/dev/null 2>&1; then
  echo "WARNING: LITESTREAM_ENABLED=true but this image has no litestream binary (built with LITESTREAM=skip?); Nook starts without it." >&2
  run "$BUN" server/index.ts
fi

set +e
exports="$("$BUN" --no-env-file server/litestream.ts prepare "$CONFIG")"
status=$?
set -e
case "$status" in
  0) ;;
  3) run "$BUN" server/index.ts ;;
  *)
    echo "Nook did not start: the Litestream settings were refused (see the line above)." >&2
    exit 1
    ;;
esac

eval "$exports"
run "$LITESTREAM" replicate -config "$CONFIG" -no-expand-env -exec "$BUN server/index.ts"
