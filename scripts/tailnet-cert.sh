#!/usr/bin/env bash
# Gets or renews the Tailscale HTTPS certificate for the tailnet profile into ./certs, named
# after TAILNET_HOST as deploy/Caddyfile.tailnet expects, then restarts Caddy if it changed.
# It does nothing while the current certificate has more than RENEW_DAYS left, so it is safe to
# run often. Tailscale certificates last about 90 days.
#
# It also fills in .env (when it exists): TAILNET_HOST if it is missing or still the example
# value, and PUBLIC_ORIGINS gets https://<host> (plus :<TAILNET_HTTPS_PORT> unless it is 443) added (the example
# placeholder entry is dropped; other origins are kept).
#
#   ./scripts/tailnet-cert.sh                run now (renews only when due)
#   ./scripts/tailnet-cert.sh --force        renew even if still valid
#   ./scripts/tailnet-cert.sh --install-cron add a daily check to your crontab
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
RENEW_DAYS=30
# cron has a minimal PATH
export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:/usr/bin"

say() { printf '%s\n' "$*" >&2; }
die() { say "error: $*"; exit 1; }

# env_get KEY: value from .env, quotes stripped.
env_get() { sed -n "s/^$1=//p" .env | head -n 1 | tr -d "'\""; }

# env_set KEY VALUE: replaces the KEY= line in .env, or appends it (value passed through the
# environment so awk does not interpret backslashes). Rewrites in place to keep the file's mode.
env_set() {
  local tmp; tmp="$(mktemp)"
  KEY="$1" VAL="$2" awk '
    BEGIN { k = ENVIRON["KEY"] "="; v = ENVIRON["VAL"] }
    index($0, k) == 1 { print k v; found = 1; next }
    { print }
    END { if (!found) print k v }
  ' .env > "$tmp" && cat "$tmp" > .env
  rm -f "$tmp"
}

FORCE=0
case "${1:-}" in
  "") ;;
  --force) FORCE=1 ;;
  --install-cron)
    line="17 4 * * * cd '$ROOT' && ./scripts/tailnet-cert.sh >> certs/renew.log 2>&1"
    current="$(crontab -l 2>/dev/null || true)"
    if printf '%s\n' "$current" | grep -qF "$ROOT' && ./scripts/tailnet-cert.sh"; then
      say "a renewal job for this folder is already in your crontab."; exit 0
    fi
    say "will add to your crontab:"; say "  $line"
    printf 'Add it? [y/N] ' >&2; IFS= read -r reply || die "no input"
    case "$reply" in y|Y|yes|YES) ;; *) say "not added."; exit 0 ;; esac
    mkdir -p certs
    { [ -z "$current" ] || printf '%s\n' "$current"; printf '%s\n' "$line"; } | crontab -
    say "added. Renewals are logged to certs/renew.log."; exit 0 ;;
  *) die "unknown option: $1 (use --force or --install-cron)" ;;
esac

command -v tailscale >/dev/null || die "tailscale is not installed or not on PATH"
command -v openssl >/dev/null || die "openssl is required"

# Host name: TAILNET_HOST from the environment or .env (read, not sourced), else this machine's name.
host="${TAILNET_HOST:-}"
if [ -z "$host" ] && [ -f .env ]; then host="$(env_get TAILNET_HOST)"; fi
case "$host" in
  ""|your-host.*)
    host="$(tailscale status --json | grep -o '"DNSName": *"[^"]*"' | head -n 1 | cut -d'"' -f4)"
    host="${host%.}"
    [ -n "$host" ] || die "set TAILNET_HOST in .env (tailscale status shows the machine's .ts.net name)"
    say "TAILNET_HOST is not set; using this machine's name: $host" ;;
esac

if [ -f .env ]; then
  case "$(env_get TAILNET_HOST)" in
    ""|your-host.*) env_set TAILNET_HOST "$host"; say "set TAILNET_HOST=$host in .env" ;;
  esac
  port="$(env_get TAILNET_HTTPS_PORT)"
  origin="https://$host"
  # browsers leave the port out of the Origin header when it is 443
  case "${port:-443}" in 443) ;; *) origin="$origin:$port" ;; esac
  current="$(env_get PUBLIC_ORIGINS)"
  wanted="$(printf '%s\n' "$current" | tr ',' '\n' | sed 's/^ *//;s/ *$//;/^$/d;/your-host/d' | { cat; echo "$origin"; } | awk '!seen[$0]++' | paste -sd, -)"
  if [ "$wanted" != "$current" ]; then env_set PUBLIC_ORIGINS "$wanted"; say "set PUBLIC_ORIGINS=$wanted in .env"; fi
else
  say "no .env yet: run ./scripts/init-env.sh, then set TAILNET_HOST and PUBLIC_ORIGINS (or run this again)."
fi

crt="certs/$host.crt"
key="certs/$host.key"
if [ "$FORCE" = 0 ] && [ -f "$crt" ] && [ -f "$key" ] && openssl x509 -checkend $((RENEW_DAYS * 86400)) -noout -in "$crt" >/dev/null; then
  say "$(date '+%F %T') $crt is valid for more than $RENEW_DAYS days; nothing to do."
  exit 0
fi

mkdir -p certs
tmp="$(mktemp -d certs/.renew.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT
say "$(date '+%F %T') requesting a certificate for $host"
tailscale cert --cert-file "$tmp/crt" --key-file "$tmp/key" "$host" \
  || die "tailscale cert failed. Is HTTPS enabled for your tailnet (admin console > DNS), and are you allowed to run it (try sudo)?"
chmod 600 "$tmp/key"
mv "$tmp/crt" "$crt"
mv "$tmp/key" "$key"
say "wrote $crt and $key, valid until $(openssl x509 -enddate -noout -in "$crt" | cut -d= -f2)"

# Caddy reads the files at start, so restart it if it is running.
if command -v docker >/dev/null && docker compose ps --status running --services 2>/dev/null | grep -qx caddy-tailnet; then
  docker compose --profile tailnet restart caddy-tailnet >/dev/null && say "restarted caddy-tailnet"
else
  say "caddy-tailnet is not running; start it with: docker compose --profile tailnet up -d"
fi
