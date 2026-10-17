#!/bin/sh
# Disposable-stack deployment smoke (audit F11 / validation gate). Proves, with REAL containers:
#   1. PostgreSQL initialises with separate roles (bootstrap superuser / migrator / DML-only app)
#   2. migrations apply as the migrator; the runtime login cannot do DDL or rewrite history
#   3. every mounted secret is readable by the container user (uid 10001 / postgres) with the modes the app enforces
#   4. the assistant starts as a NON-owner login, refuses nothing it should accept, answers /health/live and an authenticated /health/ready
#   5. an over-privileged DATABASE_URL is refused in production
# Needs: docker, root (chown of secret files). Everything lives under a temp dir and the compose project `tgvlsmoke`; no real data.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
PORT="${TGVL_HTTP_PORT:-18080}"
export TGVL_SECRETS_DIR="$TMP/secrets" TGVL_ENV_PRODUCTION="$TMP/env.production" TGVL_ENV_MIGRATE="$TMP/env.migrate" TGVL_HTTP_PORT="$PORT"
DC="docker compose -p tgvlsmoke -f $ROOT/deploy/docker-compose.yml"
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; exit 1; }
cleanup() { $DC --profile tools down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

"$ROOT/deploy/prepare-secrets.sh" "$TGVL_SECRETS_DIR" >/dev/null
APP_PW="$(cat "$TGVL_SECRETS_DIR/db_app_password")"; MIG_PW="$(cat "$TGVL_SECRETS_DIR/db_migrator_password")"; ADM_PW="$(cat "$TGVL_SECRETS_DIR/db_admin_password")"
TOKEN="$(cat "$TGVL_SECRETS_DIR/admin-token")"
cat > "$TGVL_ENV_PRODUCTION" <<ENVEOF
DATABASE_URL=postgres://tgvl_app:$APP_PW@db:5432/tgvl
OWNER_TELEGRAM_USER_ID=1
OWNER_TIMEZONE=Asia/Samarkand
MESSAGING_ADAPTER=disabled
ENVEOF
printf 'DATABASE_URL=postgres://tgvl_migrator:%s@db:5432/tgvl\n' "$MIG_PW" > "$TGVL_ENV_MIGRATE"
chmod 600 "$TGVL_ENV_PRODUCTION" "$TGVL_ENV_MIGRATE"

# SMOKE_DOCKER_BUILD_ARGS lets an environment with a restricted network pass extra `docker build` flags (e.g. --network host).
# shellcheck disable=SC2086
docker build ${SMOKE_DOCKER_BUILD_ARGS:-} --build-arg BUILD_FINGERPRINT=smoke -t tgvoicelab-assistant:smoke "$ROOT" >/tmp/tgvl-smoke-build.log 2>&1 || { tail -20 /tmp/tgvl-smoke-build.log; fail "image build"; }
export TGVL_IMAGE_TAG=smoke
pass "image builds"
$DC up -d --wait db >/dev/null || fail "database did not become healthy"
pass "database healthy (roles initialised on first start)"
PSQL_ADMIN="$DC exec -T -e PGPASSWORD=$ADM_PW db psql -h 127.0.0.1 -U tgvl_admin -d tgvl -tA -v ON_ERROR_STOP=1"
PSQL_APP="$DC exec -T -e PGPASSWORD=$APP_PW db psql -h 127.0.0.1 -U tgvl_app -d tgvl -tA"

[ "$($PSQL_ADMIN -c "select rolsuper from pg_roles where rolname='tgvl_app'")" = "f" ] || fail "tgvl_app must not be superuser"
[ "$($PSQL_ADMIN -c "select pg_get_userbyid(datdba) from pg_database where datname='tgvl'")" = "tgvl_migrator" ] || fail "database owner must be tgvl_migrator"
pass "roles: app is not superuser; schema owner is the migrator"

$DC run --rm migrate 2>&1 | grep -q '"applied":\[' || fail "migrations did not apply as the migrator"
pass "migrations applied as tgvl_migrator"

$PSQL_APP -c "create table evil (x int)" 2>&1 | grep -qi "permission denied" || fail "runtime login could create a table"
$PSQL_APP -c "delete from audit_events" 2>&1 | grep -qi "permission denied" || fail "runtime login could delete audit history"
$PSQL_APP -c "select purge_audit_events(now())" 2>&1 | grep -qi "younger than 60 days" || fail "audit purge guard missing"
pass "runtime login: no DDL, no audit rewrite, purge floor enforced"

$DC up -d assistant >/dev/null
i=0; until curl -fsS "http://127.0.0.1:$PORT/health/live" >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 40 ] && { $DC logs assistant | tail -20; fail "assistant did not become live"; }; sleep 1; done
pass "assistant live as a least-privilege login"
curl -fsS -H "authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/health/ready" | grep -q '"database":true' || fail "readiness did not report the database"
pass "authenticated /health/ready reports database up"
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/health/ready")" = "401" ] || fail "readiness must require auth"
pass "readiness requires the bearer token"

[ "$($DC exec -T assistant id -u)" = "10001" ] || fail "assistant must run as uid 10001"
for f in data_keys admin_token telegram_session; do
  $DC exec -T assistant node -e "const fs=require('fs');const p='/run/secrets/$f';fs.accessSync(p,fs.constants.R_OK);const m=fs.statSync(p).mode&0o777;process.exit((m&0o077)===0?0:3)" || fail "secret $f is not readable with mode 0400 by uid 10001"
done
pass "assistant secrets readable by uid 10001 with mode 0400"
$DC exec -T db sh -c 'for f in db_admin_password db_migrator_password db_app_password; do test -r /run/secrets/$f || exit 1; done' || fail "db secrets not readable"
pass "db secrets readable inside the database container"
$DC exec -T assistant sh -c 'touch /app/x 2>/dev/null' && fail "root filesystem must be read-only" || pass "assistant root filesystem is read-only"

# An over-privileged login must be refused in production.
$DC stop assistant >/dev/null
sed -i "s#tgvl_app:$APP_PW#tgvl_admin:$ADM_PW#" "$TGVL_ENV_PRODUCTION"
$DC up -d assistant >/dev/null; sleep 6
$DC logs assistant 2>&1 | grep -q "over-privileged role" || fail "over-privileged DATABASE_URL was not refused"
pass "over-privileged DATABASE_URL is refused in production"
echo "ALL DEPLOYMENT SMOKE CHECKS PASSED"
