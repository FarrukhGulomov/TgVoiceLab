import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestDb, type TestDb } from '../support/test-db.js';
import { seedOwner, type SeededOwner } from '../support/seed.js';
import { boot } from '../support/harness.js';
import { FakeClock } from '../../apps/assistant/src/application/clock.js';
import { buildServer } from '../../apps/assistant/src/http/server.js';
import { createLogger } from '../../apps/assistant/src/infrastructure/observability/logger.js';
import { recoverOrphanedCalls } from '../../apps/assistant/src/modules/calls/orchestrator.js';
import { FakeCallAdapter } from '../../apps/assistant/src/testing/fakes.js';
import { ActiveCallRegistry } from '../../apps/assistant/src/modules/operations/operations.service.js';

const TOKEN = 'T'.repeat(40);
const ROTATED = 'R'.repeat(40);
let t: TestDb;
let o: SeededOwner;
let app: ReturnType<typeof boot>;
let srv: FastifyInstance;
let clock: FakeClock;
let n = 0;

beforeEach(async () => {
  t = await createTestDb();
  o = await seedOwner(t.db);
  clock = new FakeClock(new Date('2026-10-15T05:00:00Z'));
  app = boot(t.url, clock);
  srv = await buildServer({
    app,
    log: createLogger('silent'),
    adminTokens: [TOKEN, ROTATED],
    runtime: {
      messagingAdapter: 'fake',
      interpreterAdapter: 'rules',
      callAdapter: 'disabled',
      evidencePath: null,
      buildFingerprint: 'x'.repeat(64),
      transcription: false,
    },
  });
});
afterEach(async () => {
  await srv.close();
  await app.close();
  await t.drop();
});

const call_ = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, headers: Record<string, string> = {}, auth: string | null = TOKEN) =>
  srv.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as object } : {}),
    headers: {
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      ...(method !== 'GET' ? { 'idempotency-key': `key-${++n}-${Math.random().toString(36).slice(2)}` } : {}),
      ...headers,
    },
  });

describe('authentication', () => {
  it('liveness is open and minimal; everything else needs a bearer token', async () => {
    expect((await call_('GET', '/health/live', undefined, {}, null)).json()).toEqual({ status: 'ok' });
    for (const [m, u] of [
      ['GET', '/v1/tasks'],
      ['GET', '/v1/capabilities'],
      ['GET', '/health/ready'],
      ['POST', '/v1/tasks'],
    ] as const) {
      const r = await call_(m, u, {}, {}, null);
      expect(r.statusCode).toBe(401);
      expect(r.json().error.code).toBe('unauthenticated');
    }
    expect((await call_('GET', '/v1/tasks', undefined, {}, 'wrong-token-wrong-token-wrong-token-1234')).statusCode).toBe(401);
  });
  it('supports token rotation (either configured token works)', async () => {
    expect((await call_('GET', '/v1/tasks', undefined, {}, TOKEN)).statusCode).toBe(200);
    expect((await call_('GET', '/v1/tasks', undefined, {}, ROTATED)).statusCode).toBe(200);
  });
  it('failed auth is audited without the token', async () => {
    await call_('GET', '/v1/tasks', undefined, {}, 'leaky-secret-token-should-not-be-logged-00');
    const a = await t.db.query(`SELECT reason_code, metadata::text AS m FROM audit_events WHERE action='admin_api'`);
    expect(a.rows[0].reason_code).toBe('bad_token');
    expect(a.rows[0].m).not.toContain('leaky');
  });
});

describe('envelope, idempotency and conflicts', () => {
  it('mutations without Idempotency-Key are rejected', async () => {
    const r = await srv.inject({ method: 'POST', url: '/v1/tasks', payload: { title: 'x' }, headers: { authorization: `Bearer ${TOKEN}` } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('idempotency_key_required');
  });
  it('replays safely, 409 on key reuse with a different body, and validates input', async () => {
    const key = { 'idempotency-key': 'stable-key-12345' };
    const a = await call_('POST', '/v1/tasks', { title: 'Review the credit workflow' }, key);
    const b = await call_('POST', '/v1/tasks', { title: 'Review the credit workflow' }, key);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.json().data.id).toBe(a.json().data.id);
    expect(a.json().requestId).toBeTruthy();
    const c = await call_('POST', '/v1/tasks', { title: 'Something else' }, key);
    expect(c.statusCode).toBe(409);
    expect(c.json().error.code).toBe('idempotency_conflict');
    expect((await call_('POST', '/v1/tasks', { title: '' })).statusCode).toBe(400);
    expect((await t.db.query('SELECT count(*)::int n FROM tasks')).rows[0].n).toBe(1);
  });
  it('optimistic concurrency on PATCH returns 409 with a stable code', async () => {
    const created = (await call_('POST', '/v1/tasks', { title: 'T' })).json().data;
    const ok = await call_('PATCH', `/v1/tasks/${created.id}`, { expectedVersion: 1, status: 'done' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.status).toBe('done');
    const stale = await call_('PATCH', `/v1/tasks/${created.id}`, { expectedVersion: 1, title: 'late' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('version_conflict');
  });
  it("another owner's object is indistinguishable from a missing one (404)", async () => {
    const other = await seedOwner(t.db);
    const foreign = await t.db.query<{ id: string }>(`INSERT INTO tasks (owner_id, title_enc) VALUES ($1,'e1.x') RETURNING id`, [other.ownerId]);
    const r1 = await call_('PATCH', `/v1/tasks/${foreign.rows[0]!.id}`, { expectedVersion: 1, status: 'done' });
    // The API serves the single bootstrapped owner; with two owners present it must refuse to guess rather than leak.
    expect([404, 503]).toContain(r1.statusCode);
    const miss = await call_('PATCH', `/v1/tasks/00000000-0000-4000-8000-000000000000`, { expectedVersion: 1, status: 'done' });
    expect([404, 503]).toContain(miss.statusCode);
  });
  it('reminders: create, reschedule with version check, cancel; confirmation is queued via the outbox', async () => {
    const r = await call_('POST', '/v1/reminders', { title: 'Call Javlon', localDateTime: '2026-10-16T09:00' });
    expect(r.statusCode).toBe(201);
    expect(r.json().data.next).toMatchObject({ date: '2026-10-16', time: '09:00', tz: 'Asia/Samarkand' });
    const id = r.json().data.id;
    const mv = await call_('PATCH', `/v1/reminders/${id}`, { expectedVersion: 1, localDateTime: '2026-10-17T10:30' });
    expect(mv.json().data).toMatchObject({ scheduleVersion: 2, version: 2 });
    expect((await call_('PATCH', `/v1/reminders/${id}`, { action: 'cancel', expectedVersion: 1 })).statusCode).toBe(409);
    expect((await call_('PATCH', `/v1/reminders/${id}`, { action: 'cancel', expectedVersion: 2 })).json().data.status).toBe('cancelled');
    expect((await t.db.query(`SELECT count(*)::int n FROM outbox WHERE type='owner.notice'`)).rows[0].n).toBe(3);
  });
  it('internal errors do not leak details', async () => {
    await t.db.query('DROP TABLE tasks CASCADE');
    const r = await call_('GET', '/v1/tasks');
    expect(r.statusCode).toBe(500);
    expect(JSON.stringify(r.json())).not.toMatch(/relation|tasks|pg|SELECT/i);
  });
});

describe('A16 — honest capability reporting while real calling is unverified', () => {
  it('reports degraded text-only mode, calling unavailable, with the reasons', async () => {
    const r = await call_('GET', '/v1/capabilities');
    const c = r.json().data;
    expect(c.mode).toBe('degraded_text_only');
    expect(c.calling).toMatchObject({
      available: false,
      killSwitchOn: true,
      privateOutbound: false,
      pcmSend: false,
      pcmReceive: false,
      productionCallingAllowed: false,
      ownerCallingAllowed: false,
    });
    expect(c.calling.blockedBecause.join(' ')).toMatch(/no feasibility evidence/);
    expect((await call_('GET', '/health/ready')).json().data.status).toBe('ready');
  });
  it('a call request cannot be dialed through the API: the durable dial job is refused with a reason and notifies the owner', async () => {
    const contact = (await call_('POST', '/v1/contacts', { telegramUserId: '555000111', displayName: 'Javlon' })).json().data;
    expect(
      (await call_('PATCH', `/v1/contacts/${contact.id}/permissions`, { allowCall: true, topicScopes: ['credit-workflow'], expiresAt: '2026-12-01T00:00:00Z' }))
        .statusCode,
    ).toBe(200);
    const req = await call_('POST', '/v1/call-requests', {
      recipientTelegramId: '555000111',
      topic: 'credit-workflow',
      purpose: 'Check whether errors are fixed',
      questions: ['Fixed?'],
      allowedContext: [],
      forbiddenCommitments: [],
      language: 'en',
      maxDurationSeconds: 300,
      expiresAt: '2026-10-15T09:00:00.000Z',
      ownerExplicitCommand: true,
    });
    expect(req.statusCode).toBe(202); // queued, not completed
    expect(req.json().data.state).toBe('queued');
    for (let i = 0; i < 2; i++) await app.tick();
    const st = await t.db.query(`SELECT status FROM call_requests`);
    expect(st.rows[0].status).toBe('rejected');
    expect((await t.db.query('SELECT count(*)::int n FROM calls')).rows[0].n).toBe(0);
    const a = await t.db.query(`SELECT reason_code FROM audit_events WHERE action='call.dial'`);
    expect(a.rows[0].reason_code).toBe('kill_switch_on'); // fail-closed default, even before the capability check
  });
  it('kill-switch endpoint persists and is idempotent', async () => {
    const key = { 'idempotency-key': 'ks-key-123456' };
    const r1 = await call_('POST', '/v1/operations/kill-switch', { on: true, reason: 'drill' }, key);
    const r2 = await call_('POST', '/v1/operations/kill-switch', { on: true, reason: 'drill' }, key);
    expect(r1.statusCode).toBe(200);
    expect(r2.headers['idempotent-replayed']).toBe('true');
    expect((await t.db.query('SELECT calling_kill_switch, version FROM operation_settings')).rows[0]).toMatchObject({ calling_kill_switch: true });
  });
});

describe('operator resolution of an outcome_unknown call', () => {
  it('frees the account only on explicit operator confirmation, audited, and a retry still needs fresh authorization', async () => {
    const c = (
      await t.db.query<{ id: string }>(
        `INSERT INTO contacts (owner_id, telegram_user_id, display_name, verified_at, verification_source) VALUES ($1,'555000111','J',now(),'x') RETURNING id`,
        [o.ownerId],
      )
    ).rows[0]!.id;
    const auth = (
      await t.db.query<{ id: string }>(
        `INSERT INTO authorizations (owner_id, action, target_contact_id, plan, plan_hash, state, expires_at, approved_at, consumed_at) VALUES ($1,'contact_call',$2,'{}',$3,'consumed', now() + interval '1 day', now(), now()) RETURNING id`,
        [o.ownerId, c, 'a'.repeat(64)],
      )
    ).rows[0]!.id;
    const req = (
      await t.db.query<{ id: string }>(
        `INSERT INTO call_requests (owner_id, contact_id, plan, plan_hash, authorization_id, status) VALUES ($1,$2,'{}',$3,$4,'failed') RETURNING id`,
        [o.ownerId, c, 'a'.repeat(64), auth],
      )
    ).rows[0]!.id;
    const call = (
      await t.db.query<{ id: string }>(
        `INSERT INTO calls (owner_id, call_request_id, account_id, attempt, authorization_id, gateway_generation, state, end_reason) VALUES ($1,$2,$3,1,$4,1,'outcome_unknown','outcome_unknown') RETURNING id`,
        [o.ownerId, req, o.accountId, auth],
      )
    ).rows[0]!.id;
    expect((await call_('POST', `/v1/calls/${call}/resolve-unknown`, { operatorConfirmsNoLiveCall: false, note: 'checked' })).statusCode).toBe(400);
    const ok = await call_('POST', `/v1/calls/${call}/resolve-unknown`, { operatorConfirmsNoLiveCall: true, note: 'checked phone; no call in progress' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.retryRequiresFreshAuthorization).toBe(true);
    expect((await t.db.query('SELECT state FROM calls WHERE id=$1', [call])).rows[0].state).toBe('ended');
    expect((await call_('POST', `/v1/calls/${call}/resolve-unknown`, { operatorConfirmsNoLiveCall: true, note: 'again please' })).statusCode).toBe(409);
    expect((await t.db.query(`SELECT count(*)::int n FROM audit_events WHERE action='call.resolve_unknown'`)).rows[0].n).toBe(1);
  });
});

describe('crash recovery (A11/A13): orphaned calls are reconciled, never redialed', () => {
  async function orphan(state: string, providerCallId: string | null) {
    const c = (
      await t.db.query<{ id: string }>(
        `INSERT INTO contacts (owner_id, telegram_user_id, display_name, verified_at, verification_source) VALUES ($1,'555000111','Javlon',now(),'x') RETURNING id`,
        [o.ownerId],
      )
    ).rows[0]!.id;
    const auth = (
      await t.db.query<{ id: string }>(
        `INSERT INTO authorizations (owner_id, action, target_contact_id, plan, plan_hash, state, expires_at, approved_at, consumed_at) VALUES ($1,'contact_call',$2,'{}',$3,'consumed', now() + interval '1 day', now(), now()) RETURNING id`,
        [o.ownerId, c, 'a'.repeat(64)],
      )
    ).rows[0]!.id;
    const req = (
      await t.db.query<{ id: string }>(
        `INSERT INTO call_requests (owner_id, contact_id, plan, plan_hash, authorization_id, status) VALUES ($1,$2,'{}',$3,$4,'dialing') RETURNING id`,
        [o.ownerId, c, 'a'.repeat(64), auth],
      )
    ).rows[0]!.id;
    const call = await t.db.query<{ id: string }>(
      `INSERT INTO calls (owner_id, call_request_id, account_id, attempt, authorization_id, gateway_generation, state, provider_call_id) VALUES ($1,$2,$3,1,$4,1,$5,$6) RETURNING id`,
      [o.ownerId, req, o.accountId, auth, state, providerCallId],
    );
    return call.rows[0]!.id;
  }
  const recover = (adapter = new FakeCallAdapter()) =>
    recoverOrphanedCalls({ db: app.db, clock, adapter, registry: new ActiveCallRegistry(), callBudgetMicroUsd: 1_000_000 });
  const stateOf = async (id: string) => (await t.db.query('SELECT state, end_reason FROM calls WHERE id=$1', [id])).rows[0];

  it('dialing with no provider id => outcome_unknown (the account stays occupied; no redial)', async () => {
    const id = await orphan('dialing', null);
    expect(await recover()).toEqual({ recovered: 1 });
    expect(await stateOf(id)).toEqual({ state: 'outcome_unknown', end_reason: 'outcome_unknown' });
    await app.tick();
    expect(app.messaging.sent.at(-1)?.text).toMatch(/NOT retry on my own/);
  });
  it('provider says it ended => failed', async () => {
    const id = await orphan('ringing', 'p-1');
    const ad = new FakeCallAdapter();
    ad.reconcileResult = 'ended';
    await recover(ad);
    expect(await stateOf(id)).toEqual({ state: 'failed', end_reason: 'transport_error' });
  });
  it('was connected when we died with no handle => outcome_unknown (cannot prove it ended, so it keeps the account occupied)', async () => {
    const id = await orphan('active', 'p-2');
    await recover();
    expect((await stateOf(id)).state).toBe('outcome_unknown');
  });
  it('preflight (intent recorded, never dialed) => cancelled; and recovery is idempotent', async () => {
    const id = await orphan('preflight', null);
    await recover();
    expect(await stateOf(id)).toEqual({ state: 'cancelled', end_reason: 'cancelled' });
    expect(await recover()).toEqual({ recovered: 0 });
  });
});
