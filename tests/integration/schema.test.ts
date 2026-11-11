import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../support/test-db.js';
import { seedCallScaffold, seedContact, seedOwner } from '../support/seed.js';
import { migrate } from '../../apps/assistant/src/infrastructure/db/migrate.js';
import { MIGRATIONS_DIR } from '../../apps/assistant/src/infrastructure/db/paths.js';
import { mkdtempSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const insertCall = (accountId: string, ownerId: string, callRequestId: string, authorizationId: string, state: string, attempt = 1) =>
  t.db.query(
    `INSERT INTO calls (owner_id, call_request_id, account_id, attempt, authorization_id, gateway_generation, state, end_reason)
     VALUES ($1,$2,$3,$4,$5,1,$6, CASE WHEN $6 IN ('ended','declined','busy','no_answer','failed','consent_denied','cancelled') THEN 'completed' END)`,
    [ownerId, callRequestId, accountId, attempt, authorizationId, state],
  );

describe('migrations', () => {
  it('are idempotent: second run applies nothing', async () => {
    const r = await migrate(t.db, MIGRATIONS_DIR);
    expect(r.applied).toEqual([]);
    expect(r.alreadyApplied.length).toBeGreaterThan(0);
  });
  it('detect edits to an already-applied migration (checksum)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    copyFileSync(join(MIGRATIONS_DIR, '0001_core_schema.sql'), join(dir, '0001_core_schema.sql'));
    writeFileSync(join(dir, '0001_core_schema.sql'), '-- tampered\nSELECT 1;\n');
    await expect(migrate(t.db, dir)).rejects.toThrow(/modified after being applied/);
  });
  it('rolls back a failing migration atomically and rejects bad filenames', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    copyFileSync(join(MIGRATIONS_DIR, '0001_core_schema.sql'), join(dir, '0001_core_schema.sql'));
    writeFileSync(join(dir, '0002_bad.sql'), 'CREATE TABLE half_done (id int); SELECT * FROM does_not_exist;');
    await expect(migrate(t.db, dir)).rejects.toThrow(/0002_bad.sql failed/);
    const r = await t.db.query(`SELECT to_regclass('half_done') AS t`);
    expect(r.rows[0].t).toBeNull();
    writeFileSync(join(dir, 'oops.sql'), 'SELECT 1');
    await expect(migrate(t.db, dir)).rejects.toThrow(/bad migration filename/);
  });
});

describe('fail-closed defaults', () => {
  it('calling kill switch defaults to ON for a new owner', async () => {
    const o = await seedOwner(t.db);
    const r = await t.db.query('SELECT calling_kill_switch FROM operation_settings WHERE owner_id=$1', [o.ownerId]);
    expect(r.rows[0].calling_kill_switch).toBe(true);
  });
  it('rejects non-numeric / zero-leading Telegram ids as identity', async () => {
    await expect(t.db.query(`INSERT INTO owners (telegram_user_id) VALUES ('@javlon')`)).rejects.toThrow(/check/);
    await expect(t.db.query(`INSERT INTO owners (telegram_user_id) VALUES ('0123')`)).rejects.toThrow(/check/);
  });
  it('rejects a second owner with the same Telegram id', async () => {
    const o = await seedOwner(t.db);
    await expect(t.db.query(`INSERT INTO owners (telegram_user_id) VALUES ($1)`, [o.telegramUserId])).rejects.toThrow(/unique|duplicate/);
  });
});

describe('one active call per assistant account (database-enforced)', () => {
  it('blocks a second non-terminal call and allows one after the first is terminal', async () => {
    const o = await seedOwner(t.db);
    const c = await seedContact(t.db, o.ownerId);
    const a = await seedCallScaffold(t.db, o.ownerId, c);
    const b = await seedCallScaffold(t.db, o.ownerId, c);
    await insertCall(o.accountId, o.ownerId, a.callRequestId, a.authorizationId, 'dialing');
    await expect(insertCall(o.accountId, o.ownerId, b.callRequestId, b.authorizationId, 'preflight')).rejects.toThrow(/calls_one_active_per_account/);
    await t.db.query(`UPDATE calls SET state='declined', end_reason='declined' WHERE call_request_id=$1`, [a.callRequestId]);
    await insertCall(o.accountId, o.ownerId, b.callRequestId, b.authorizationId, 'preflight');
  });
  it('outcome_unknown still occupies the account until reconciled', async () => {
    const o = await seedOwner(t.db);
    const c = await seedContact(t.db, o.ownerId);
    const a = await seedCallScaffold(t.db, o.ownerId, c);
    const b = await seedCallScaffold(t.db, o.ownerId, c);
    await insertCall(o.accountId, o.ownerId, a.callRequestId, a.authorizationId, 'outcome_unknown');
    await expect(insertCall(o.accountId, o.ownerId, b.callRequestId, b.authorizationId, 'preflight')).rejects.toThrow(/calls_one_active_per_account/);
  });
  it('concurrent inserts: exactly one wins', async () => {
    const o = await seedOwner(t.db);
    const c = await seedContact(t.db, o.ownerId);
    const scaffolds = await Promise.all(Array.from({ length: 6 }, () => seedCallScaffold(t.db, o.ownerId, c)));
    const results = await Promise.allSettled(scaffolds.map((s) => insertCall(o.accountId, o.ownerId, s.callRequestId, s.authorizationId, 'dialing')));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
  it('an authorization is single-use across call attempts', async () => {
    const o = await seedOwner(t.db);
    const c = await seedContact(t.db, o.ownerId);
    const a = await seedCallScaffold(t.db, o.ownerId, c);
    await insertCall(o.accountId, o.ownerId, a.callRequestId, a.authorizationId, 'declined');
    await expect(insertCall(o.accountId, o.ownerId, a.callRequestId, a.authorizationId, 'preflight', 2)).rejects.toThrow(/unique|duplicate/);
  });
});

describe('owner isolation (composite foreign keys)', () => {
  it("cannot link another owner's contact into a call request or permission", async () => {
    const o1 = await seedOwner(t.db);
    const o2 = await seedOwner(t.db);
    const contactOfO2 = await seedContact(t.db, o2.ownerId);
    await expect(
      t.db.query(`INSERT INTO call_requests (owner_id, contact_id, plan, plan_hash) VALUES ($1,$2,'{}',$3)`, [o1.ownerId, contactOfO2, 'b'.repeat(64)]),
    ).rejects.toThrow(/foreign key/);
    await expect(
      t.db.query(`INSERT INTO contact_permissions (owner_id, contact_id, version, expires_at) VALUES ($1,$2,1, now() + interval '1 day')`, [
        o1.ownerId,
        contactOfO2,
      ]),
    ).rejects.toThrow(/foreign key/);
  });
  it("cannot attach another owner's task to a reminder", async () => {
    const o1 = await seedOwner(t.db);
    const o2 = await seedOwner(t.db);
    const task = await t.db.query<{ id: string }>(`INSERT INTO tasks (owner_id, title_enc) VALUES ($1,'e1.x') RETURNING id`, [o2.ownerId]);
    await expect(
      t.db.query(`INSERT INTO reminders (owner_id, task_id, title_enc, local_wall_clock, timezone) VALUES ($1,$2,'e1.x', now()::timestamp, 'Asia/Samarkand')`, [
        o1.ownerId,
        task.rows[0]!.id,
      ]),
    ).rejects.toThrow(/foreign key/);
  });
  it("cannot create a call using another owner's account or authorization", async () => {
    const o1 = await seedOwner(t.db);
    const o2 = await seedOwner(t.db);
    const c1 = await seedContact(t.db, o1.ownerId);
    const s1 = await seedCallScaffold(t.db, o1.ownerId, c1);
    await expect(insertCall(o2.accountId, o1.ownerId, s1.callRequestId, s1.authorizationId, 'preflight')).rejects.toThrow(/foreign key/);
  });
});

describe('append-only tables', () => {
  it('audit_events and consent_events reject UPDATE and DELETE; retention job may delete', async () => {
    const o = await seedOwner(t.db);
    await t.db.query(`INSERT INTO audit_events (owner_id, actor_type, action, allowed, reason_code) VALUES ($1,'system','x',true,'ok')`, [o.ownerId]);
    await expect(t.db.query(`UPDATE audit_events SET reason_code='tampered'`)).rejects.toThrow(/append-only/);
    await expect(t.db.query(`DELETE FROM audit_events`)).rejects.toThrow(/retention job/);
    await t.db.tx(async (c) => {
      await c.query(`SELECT set_config('app.retention_delete','on',true)`);
      await c.query(`DELETE FROM audit_events WHERE owner_id=$1`, [o.ownerId]);
    });
    const r = await t.db.query('SELECT count(*)::int AS n FROM audit_events WHERE owner_id=$1', [o.ownerId]);
    expect(r.rows[0].n).toBe(0);

    const c = await seedContact(t.db, o.ownerId);
    const s = await seedCallScaffold(t.db, o.ownerId, c);
    const call = await t.db.query<{ id: string }>(
      `INSERT INTO calls (owner_id, call_request_id, account_id, attempt, authorization_id, gateway_generation, state) VALUES ($1,$2,$3,1,$4,1,'awaiting_consent') RETURNING id`,
      [o.ownerId, s.callRequestId, o.accountId, s.authorizationId],
    );
    await t.db.query(
      `INSERT INTO consent_events (owner_id, call_id, subject_telegram_id, kind, decision, source, disclosure_version) VALUES ($1,$2,'123','ai_processing','denied','local_recognizer','v1')`,
      [o.ownerId, call.rows[0]!.id],
    );
    await expect(t.db.query(`UPDATE consent_events SET decision='granted'`)).rejects.toThrow(/append-only/);
  });
});

describe('value constraints', () => {
  it('rejects expired-at-creation permissions/authorizations, negative budgets and attempts', async () => {
    const o = await seedOwner(t.db);
    const c = await seedContact(t.db, o.ownerId);
    await expect(
      t.db.query(`INSERT INTO contact_permissions (owner_id, contact_id, version, expires_at, created_at) VALUES ($1,$2,1, now() - interval '1 day', now())`, [
        o.ownerId,
        c,
      ]),
    ).rejects.toThrow(/check/);
    await expect(
      t.db.query(`INSERT INTO usage_budgets (owner_id, day, cap_micro_usd, reserved_micro_usd) VALUES ($1, current_date, 100, 200)`, [o.ownerId]),
    ).rejects.toThrow(/check/);
    await expect(t.db.query(`INSERT INTO jobs (owner_id, kind, due_at, attempts) VALUES ($1,'k', now(), -1)`, [o.ownerId])).rejects.toThrow(/check/);
  });
  it('duplicate provider message ids are rejected (durable dedupe)', async () => {
    const o = await seedOwner(t.db);
    const conv = await t.db.query<{ id: string }>(
      `INSERT INTO conversations (owner_id, actor_role, channel) VALUES ($1,'owner','telegram_text') RETURNING id`,
      [o.ownerId],
    );
    const ins = () =>
      t.db.query(
        `INSERT INTO messages (owner_id, conversation_id, account_id, provider_message_id, direction, occurred_at) VALUES ($1,$2,$3,'m-1','inbound', now())`,
        [o.ownerId, conv.rows[0]!.id, o.accountId],
      );
    await ins();
    await expect(ins()).rejects.toThrow(/unique|duplicate/);
  });
});
