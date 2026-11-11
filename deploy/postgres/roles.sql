-- Least-privilege database roles (audit F11). Run ONCE per database by the PostgreSQL superuser:
--   psql -v db=tgvl -v migrator_pw=... -v app_pw=... -f roles.sql
-- Idempotent. Three actors, never the same login:
--   bootstrap superuser (POSTGRES_USER) : created by the image; used only to run this file and for break-glass maintenance
--   tgvl_migrator                       : owns the schema; runs forward-only migrations; NOT used by the running app
--   tgvl_app                            : runtime login. DML on application tables only: no DDL, no triggers, no role/grant changes,
--                                         no UPDATE/DELETE on append-only tables (see migration 0007), no write to schema_migrations.
SELECT 'CREATE ROLE tgvl_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tgvl_migrator') \gexec
SELECT 'CREATE ROLE tgvl_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tgvl_app') \gexec
ALTER ROLE tgvl_migrator PASSWORD :'migrator_pw';
ALTER ROLE tgvl_app PASSWORD :'app_pw';

SELECT format('ALTER DATABASE %I OWNER TO tgvl_migrator', :'db') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO tgvl_app', :'db') \gexec

\connect :"db"
ALTER SCHEMA public OWNER TO tgvl_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO tgvl_app;
-- Objects the migrator creates from now on are usable (DML only) by the runtime role.
ALTER DEFAULT PRIVILEGES FOR ROLE tgvl_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tgvl_app;
ALTER DEFAULT PRIVILEGES FOR ROLE tgvl_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO tgvl_app;
