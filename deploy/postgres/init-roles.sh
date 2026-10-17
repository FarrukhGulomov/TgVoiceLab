#!/bin/sh
# Mounted into /docker-entrypoint-initdb.d: runs once, at first initialization of an empty data directory.
# Passwords come from Docker secret files, never from environment values or the image.
set -eu
secret() { tr -d '\r\n' < "$1"; }
exec psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v "db=$POSTGRES_DB" \
  -v "migrator_pw=$(secret /run/secrets/db_migrator_password)" \
  -v "app_pw=$(secret /run/secrets/db_app_password)" \
  -f /opt/tgvl/roles.sql
