-- Audit F11: privilege hardening that holds when the application runs as a NON-owner, DML-only login (deploy/postgres/roles.sql).
-- The append-only triggers guard against accidents; they are NOT a boundary against a privileged database actor (a superuser or the
-- schema owner can still disable them). The real boundary for the runtime login is the privilege set below.

-- 1) Audit purge is a narrow SECURITY DEFINER function (owned by the migrating role): the runtime login has no DELETE on
--    audit_events at all, and cannot purge rows younger than 60 days even if the application is compromised.
CREATE OR REPLACE FUNCTION purge_audit_events(cutoff timestamptz) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE n bigint;
BEGIN
  IF cutoff > now() - interval '60 days' THEN
    RAISE EXCEPTION 'audit rows younger than 60 days cannot be purged' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  PERFORM set_config('app.retention_delete', 'on', true);
  DELETE FROM audit_events WHERE created_at < cutoff;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('app.retention_delete', 'off', true);
  RETURN n;
END; $$;
REVOKE ALL ON FUNCTION purge_audit_events(timestamptz) FROM PUBLIC;

-- 2) Tighten what the runtime login can do (only when that role exists; with a single-login dev setup this is a no-op).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tgvl_app') THEN
    GRANT EXECUTE ON FUNCTION purge_audit_events(timestamptz) TO tgvl_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_events, consent_events FROM tgvl_app;
    REVOKE ALL ON schema_migrations FROM tgvl_app;
    GRANT SELECT ON schema_migrations TO tgvl_app;
  END IF;
END $$;
