import type { Queryable } from './db.js';

/**
 * Inspect the privileges of the CURRENT database login (audit F11). The runtime must not be a superuser, a role/db creator, the
 * schema owner, or able to alter append-only history. Returns human-readable violations (empty = least privilege).
 */
export async function leastPrivilegeViolations(q: Queryable): Promise<string[]> {
  const r = await q.query<{
    rolsuper: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
    rolbypassrls: boolean;
    can_create: boolean;
    owns_objects: boolean;
    mutates_history: boolean;
    rolname: string;
  }>(
    `SELECT r.rolname, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls,
            has_schema_privilege(current_user, 'public', 'CREATE') AS can_create,
            EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND pg_get_userbyid(c.relowner) = current_user) AS owns_objects,
            (has_table_privilege(current_user, 'audit_events', 'UPDATE') OR has_table_privilege(current_user, 'audit_events', 'DELETE')
             OR has_table_privilege(current_user, 'consent_events', 'UPDATE') OR has_table_privilege(current_user, 'consent_events', 'DELETE')) AS mutates_history
     FROM pg_roles r WHERE r.rolname = current_user`,
  );
  const x = r.rows[0];
  if (!x) return ['cannot inspect the current database role'];
  const v: string[] = [];
  if (x.rolsuper) v.push('role is a superuser');
  if (x.rolcreaterole) v.push('role can create roles');
  if (x.rolcreatedb) v.push('role can create databases');
  if (x.rolbypassrls) v.push('role bypasses row-level security');
  if (x.can_create) v.push('role can create objects in schema public');
  if (x.owns_objects) v.push('role owns schema objects (it could alter or drop triggers and constraints)');
  if (x.mutates_history) v.push('role can UPDATE/DELETE append-only audit/consent history');
  return v;
}
