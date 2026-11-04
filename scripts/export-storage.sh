#!/usr/bin/env bash
# Exports everything in RustFS (all recordings) to one .tar file on this machine, as ordinary files named by
# their storage key, plus a manifest.json with each file's size and SHA-256. The app container must be running.
#   npm run export:storage                    # writes ./rustfs-export-<date>-<time>.tar
#   npm run export:storage -- /backups/x.tar  # or a file you name
# Uploads that finish after it starts may be missing. Details: docs/operations.md#video
set -euo pipefail

OUT="${1:-rustfs-export-$(date +%Y%m%d-%H%M%S).tar}"
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac
cd "$(dirname "$0")/.."

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
[ ! -e "$OUT" ] || die "$OUT already exists"
[ -n "$(docker compose ps --status running -q app)" ] || die "the app container is not running (start the stack first)"

TMP="$OUT.partial"
trap 'rm -f "$TMP"' EXIT

# written under another name until it is complete, so a failed run never leaves a file that looks finished
docker compose exec -T app node --input-type=module -e "$(cat scripts/export-storage.mjs)" >"$TMP"

EXPECTED="$(tar -xOf "$TMP" manifest.json | grep -c '"key":' || true)"
FOUND="$(tar -tf "$TMP" | grep -vc '^manifest\.json$' || true)"
[ "$FOUND" = "$EXPECTED" ] || die "the archive holds $FOUND objects, expected $EXPECTED; nothing was saved"

mv "$TMP" "$OUT"
printf 'saved %s: %s objects, %s\n' "$OUT" "$FOUND" "$(du -h "$OUT" | cut -f1)" >&2
