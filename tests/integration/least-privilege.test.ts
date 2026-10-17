import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_URL, adminClient } from '../support/pg.js';
import { Db } from '../../apps/assistant/src/infrastructure/db/db.js';
import { migrate } from '../../apps/assistant/src/infrastructure/db/migrate.js';
import { leastPrivilegeViolations } from '../../apps/assistant/src/infrastructure/db/role-check.js';
import { runRetention } from '../../apps/assistant/src/modules/retention/retention.js';

/**
 * Audit F11. Real PostgreSQL roles created by the SAME deploy/postgres/roles.sql the container uses; migrations run as the
 * migrator, the application runs as the DML-only login. Asserts what the runtime login can and cannot do.
 */
const dbName = `tgvl_lp_${randomBytes(4).toString('hex')}`;
const MIGRATOR_PW = randomBytes(12).toString('hex');
const APP_PW = randomBytes(12).toString('hex');
const urlAs = (user: string, pw: string) => {
  const u = new URL(ADMIN_URL);
  u.username = user;
  u.password = pw;
  u.pathname = `/${dbName}`;
  return u.toString();
};
let migrator: Db;
let app: Db;
const sqlstate = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
};

beforeAll(async () => {
  const admin = await adminClient();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const u = new URL(ADMIN_URL);
  const r = spawnSync(
    'psql',
    [
      ADMIN_URL,
      '-v',
      'ON_ERROR_STOP=1',
      '-v',
      `db=${dbName}`,
      '-v',
      `migrator_pw=${MIGRATOR_PW}`,
      '-v',
      `app_pw=${APP_PW}`,
      '-f',
      resolve('deploy/postgres/roles.sql'),
    ],
    { env: { ...process.env, PGPASSWORD: decodeURIComponent(u.password) }, encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`roles.sql failed: ${r.stderr}`);
  migrator = new Db(urlAs('tgvl_migrator', MIGRATOR_PW), undefined, 2);
  await migrate(migrator, resolve('db/migrations'));
  app = new Db(urlAs('tgvl_app', APP_PW), undefined, 4);
});
afterAll(async () => {
  await app?.close();
  await migrator?.close();
  const admin = await adminClient();
  await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1`, [dbName]);
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.end();
});

describe('F11 — the runtime login is least-privilege', () => {
  it('reports no violations for tgvl_app, and violations for the schema owner', async () => {
    expect(await leastPrivilegeViolations(app)).toEqual([]);
    const v = await leastPrivilegeViolations(migrator);
    expect(v.join(' ')).toMatch(/owns schema objects/);
    expect(v.join(' ')).toMatch(/can create objects/);
  });
  it('cannot run DDL, touch triggers, grant, or create roles', async () => {
    expect(await sqlstate(app.query('CREATE TABLE evil (x int)'))).toBe('42501');
    expect(await sqlstate(app.query('ALTER TABLE tasks DISABLE TRIGGER ALL'))).toBe('42501');
    expect(await sqlstate(app.query('DROP TRIGGER audit_events_append_only ON audit_events'))).toBe('42501');
    // GRANT by a non-owner only warns ("no privileges were granted"); what matters is that the ACL did not change.
    const acl = async () => (await app.query<{ a: string }>(`SELECT relacl::text AS a FROM pg_class WHERE relname='tasks'`)).rows[0]!.a;
    const before = await acl();
    await app.query('GRANT ALL ON tasks TO PUBLIC');
    expect(await acl()).toBe(before);
    expect(before).not.toMatch(/^\{=/); // nothing granted to PUBLIC
    expect(await sqlstate(app.query('CREATE ROLE sneaky'))).toBe('42501');
    expect(await sqlstate(app.query('TRUNCATE tasks'))).toBe('42501');
  });
  it('cannot rewrite append-only history, even by setting the retention GUC itself', async () => {
    const owner = (await app.query<{ id: string }>(`INSERT INTO owners (telegram_user_id) VALUES ('42') RETURNING id`)).rows[0]!.id;
    await app.query(`INSERT INTO audit_events (owner_id, actor_type, action, allowed, reason_code) VALUES ($1,'system','x',true,'ok')`, [owner]);
    expect(await sqlstate(app.query(`UPDATE audit_events SET reason_code='forged'`))).toBe('42501');
    expect(await sqlstate(app.query(`DELETE FROM audit_events`))).toBe('42501');
    const c = await app.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.retention_delete','on',true)`);
      expect(await sqlstate(c.query(`DELETE FROM audit_events`))).toBe('42501'); // the GUC is not a boundary: the privilege is missing
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
    expect(await sqlstate(app.query(`UPDATE consent_events SET disclosure_version='x'`))).toBe('42501');
  });
  it('can purge only audit rows older than 60 days through the narrow function', async () => {
    const owner = (await app.query<{ id: string }>(`SELECT id FROM owners LIMIT 1`)).rows[0]!.id;
    await app.query(
      `INSERT INTO audit_events (owner_id, actor_type, action, allowed, reason_code, created_at) VALUES ($1,'system','old',true,'ok', now() - interval '100 days')`,
      [owner],
    );
    expect(await sqlstate(app.query(`SELECT purge_audit_events(now())`))).toBe('23000'); // integrity_constraint_violation class
    expect(await sqlstate(app.query(`SELECT purge_audit_events(now() - interval '30 days')`))).toBe('23000');
    const purged = (await app.query<{ n: string }>(`SELECT purge_audit_events(now() - interval '90 days') AS n`)).rows[0]!.n;
    expect(Number(purged)).toBe(1);
    expect((await app.query(`SELECT count(*)::int n FROM audit_events WHERE action='x'`)).rows[0].n).toBe(1); // recent row survives
  });
  it('cannot tamper with migration history but can read it; migrator can apply forward migrations', async () => {
    expect(await sqlstate(app.query(`DELETE FROM schema_migrations`))).toBe('42501');
    expect(await sqlstate(app.query(`UPDATE schema_migrations SET checksum='x'`))).toBe('42501');
    expect((await app.query(`SELECT count(*)::int n FROM schema_migrations`)).rows[0].n).toBeGreaterThanOrEqual(7);
    const again = await migrate(migrator, resolve('db/migrations'));
    expect(again.applied).toEqual([]);
  });
  it('the whole retention sweep works as the least-privilege login', async () => {
    const r = await runRetention(app, new Date());
    expect(r).toHaveProperty('audit');
  });
});

void pg;
