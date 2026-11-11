#!/bin/sh
# Create any MISSING deployment secrets with the owners/modes the containers need. Never overwrites an existing file.
# Needs root (chown to the container uids). Usage: sudo deploy/prepare-secrets.sh [secrets-dir]
set -eu
DIR="${1:-${TGVL_SECRETS_DIR:-$(dirname "$0")/../.local/secrets}}"
mkdir -p "$DIR"
chmod 700 "$DIR"
rand() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
mk() { # name owner content
  if [ ! -e "$DIR/$1" ]; then umask 077; printf '%s' "$3" > "$DIR/$1"; echo "created $1"; fi
  chown "$2" "$DIR/$1"; chmod 400 "$DIR/$1"
}
mk db_admin_password 999:999 "$(rand)"
mk db_migrator_password 999:999 "$(rand)"
mk db_app_password 999:999 "$(rand)"
mk data-keys.json 10001:10001 "{\"active\":\"k1\",\"keys\":{\"k1\":\"$(head -c 32 /dev/urandom | base64)\"}}"
mk admin-token 10001:10001 "$(rand)"
[ -e "$DIR/telegram.session" ] || { echo "NOTE: telegram.session is created by 'pnpm spike:login'; writing an empty placeholder (messaging stays disabled)"; mk telegram.session 10001:10001 ""; }
chown 10001:10001 "$DIR/telegram.session"; chmod 400 "$DIR/telegram.session"
echo "secrets ready in $DIR"
