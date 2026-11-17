#!/usr/bin/env bash
# Creates .env from .env.example and seeds the secrets: database password, storage access/secret
# key and the first admin's password (random, or one you type). Everything else is copied as is;
# edit the host names and origins in .env afterwards. Run it from anywhere: npm run init:env
set -euo pipefail

cd "$(dirname "$0")/.."
ENV_FILE=.env
EXAMPLE=.env.example
ADMIN_MIN=12
ADMIN_MAX=128

say() { printf '%s\n' "$*" >&2; }
die() { say "error: $*"; exit 1; }
ask() { printf '%s' "$1" >&2; IFS= read -r REPLY || die "no input"; }
ask_secret() { printf '%s' "$1" >&2; IFS= read -rs REPLY || die "no input"; printf '\n' >&2; }

command -v openssl >/dev/null || die "openssl is required"
[ -f "$EXAMPLE" ] || die "$EXAMPLE not found"

# Hex only, so the values are safe in URLs, shell and Docker's .env parser.
rand_hex() { openssl rand -hex "$1"; }

# Prints the value as it must be written in .env: bare when plain, single-quoted otherwise
# (Docker Compose and Node's --env-file treat single quotes literally, so $ and # stay intact).
dotenv_value() {
  case "$1" in
    *[!A-Za-z0-9._@%+=:,/-]*) printf "'%s'" "$1" ;;
    *) printf '%s' "$1" ;;
  esac
}

# set_var KEY VALUE: replaces the KEY= line in the working file (value passed through the
# environment so awk does not interpret backslashes).
set_var() {
  KEY="$1" VAL="$(dotenv_value "$2")" awk '
    BEGIN { k = ENVIRON["KEY"] "="; v = ENVIRON["VAL"] }
    index($0, k) == 1 { print k v; found = 1; next }
    { print }
    END { if (!found) print k v }
  ' "$WORK" > "$WORK.new" && mv "$WORK.new" "$WORK"
}

get_var() { sed -n "s/^$1=//p" "${2:-$WORK}" | head -n 1; }

if [ -f "$ENV_FILE" ]; then
  say "$ENV_FILE already exists."
  say "Re-seeding replaces POSTGRES_PASSWORD, the S3 keys and ANONYMIZER_TOKEN (the anonymizer machine must be given the new one). Those only take effect on a fresh"
  say "database / storage volume; an existing volume keeps the old ones. The old file is kept as $ENV_FILE.bak."
  ask "Replace the secrets in $ENV_FILE? [y/N] "
  case "$REPLY" in y|Y|yes|YES) ;; *) say "left $ENV_FILE untouched."; exit 0 ;; esac
  SOURCE="$ENV_FILE"
else
  SOURCE="$EXAMPLE"
fi

# Admin password: ask before touching anything.
say ""
say "Admin password (the first admin is created from it on first start):"
say "  1) generate a random one"
say "  2) enter my own (min $ADMIN_MIN characters)"
while :; do
  ask "Choose [1/2] (default 1): "
  case "${REPLY:-1}" in
    1) ADMIN_PW="$(rand_hex 16)"; ADMIN_GENERATED=1; break ;;
    2) ADMIN_GENERATED=0; break ;;
    *) say "enter 1 or 2." ;;
  esac
done

while [ "$ADMIN_GENERATED" = 0 ]; do
  ask_secret "Admin password: "; ADMIN_PW="$REPLY"
  if [ "${#ADMIN_PW}" -lt "$ADMIN_MIN" ]; then say "too short: at least $ADMIN_MIN characters."; continue; fi
  if [ "${#ADMIN_PW}" -gt "$ADMIN_MAX" ]; then say "too long: at most $ADMIN_MAX characters."; continue; fi
  case "$ADMIN_PW" in *"'"*) say "the password cannot contain a single quote."; continue ;; esac
  ask_secret "Repeat it: "
  [ "$REPLY" = "$ADMIN_PW" ] || { say "they do not match."; continue; }
  break
done

WORK="$(mktemp "${TMPDIR:-/tmp}/field-capture-env.XXXXXX")"
trap 'rm -f "$WORK" "$WORK.new"' EXIT
chmod 600 "$WORK"
cp "$SOURCE" "$WORK"

DB_PW="$(rand_hex 24)"
set_var POSTGRES_PASSWORD "$DB_PW"
set_var S3_ACCESS_KEY "$(rand_hex 10)"
set_var S3_SECRET_KEY "$(rand_hex 20)"
set_var ANONYMIZER_TOKEN "$(rand_hex 32)"
set_var ADMIN_PASSWORD "$ADMIN_PW"

# DATABASE_URL (host development) carries the same database password.
url="$(get_var DATABASE_URL)"
if [[ "$url" =~ ^(postgres(ql)?://[^:/@]+:)[^@]*(@.*)$ ]]; then
  set_var DATABASE_URL "${BASH_REMATCH[1]}${DB_PW}${BASH_REMATCH[3]}"
else
  say "warning: could not find a password in DATABASE_URL; set it to use the same password as POSTGRES_PASSWORD."
fi

[ "$SOURCE" = "$ENV_FILE" ] && cp -p "$ENV_FILE" "$ENV_FILE.bak"
mv "$WORK" "$ENV_FILE"
chmod 600 "$ENV_FILE"

say ""
say "wrote $ENV_FILE (mode 600) with new POSTGRES_PASSWORD, DATABASE_URL, S3_ACCESS_KEY, S3_SECRET_KEY, ANONYMIZER_TOKEN, ADMIN_PASSWORD."
say "admin username: $(get_var ADMIN_USERNAME "$ENV_FILE")"
if [ "$ADMIN_GENERATED" = 1 ]; then
  say "admin password: $ADMIN_PW"
  say "(shown once here; it is also in $ENV_FILE. Change it in the app after the first login.)"
fi
say "next: set PUBLIC_ORIGINS, TAILNET_HOST / DOMAIN in $ENV_FILE, then start the stack (see README)."
