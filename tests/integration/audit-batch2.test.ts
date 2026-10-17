import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestDb, type TestDb } from '../support/test-db.js';
import { seedOwner, type SeededOwner } from '../support/seed.js';
import { boot } from '../support/harness.js';
import { FakeClock } from '../../apps/assistant/src/application/clock.js';
import { buildServer } from '../../apps/assistant/src/http/server.js';
import { createLogger } from '../../apps/assistant/src/infrastructure/observability/logger.js';
import { FakeCallAdapter, FakeMessaging } from '../../apps/assistant/src/testing/fakes.js';
import { ensureDailyBudget } from '../../apps/assistant/src/modules/operations/operations.service.js';
import { enqueueJob } from '../../apps/assistant/src/modules/jobs/jobs.js';
import type { DerivedCapabilities } from '../../apps/assistant/src/modules/calls/capability-evidence.js';

/** Audit F03 (atomic admin writes), F12 (cancelled requests are never dialable), F20 (permission version allocation). */
const TOKEN = 'T'.repeat(40);
const ALL_PASS: DerivedCapabilities = {
  privateOutbound: true,
  privateInbound: false,
  pcmSend: true,
  pcmReceive: true,
  evidenceArtifact: 'TEST-ONLY',
  buildFingerprint: 'test',
  productionCallingAllowed: true,
  thirdPartyConsentMechanismProven: true,
  reasons: [],
};
const NOW = '2026-10-15T06:00:00Z'; // 11:00 Samarkand
let t: TestDb;
let o: SeededOwner;
let app: ReturnType<typeof boot>;
let srv: FastifyInstance;
let adapter: FakeCallAdapter;
let clock: FakeClock;
let contactId: string;
let k = 0;

beforeEach(async () => {
  t = await createTestDb();
  o = await seedOwner(t.db);
  clock = new FakeClock(new Date(NOW));
  adapter = new FakeCallAdapter();
  adapter.script = { kind: 'answer' };
  app = boot(t.url, clock, new FakeMessaging(), 'w', { callAdapter: adapter, deriveCapabilities: () => ALL_PASS, ringTimeoutMs: 200 });
  srv = await buildServer({
    app,
    log: createLogger('silent'),
    adminTokens: [TOKEN],
    runtime: {
      messagingAdapter: 'fake',
      interpreterAdapter: 'rules',
      callAdapter: 'disabled',
      evidencePath: null,
      buildFingerprint: 'x'.repeat(64),
      transcription: false,
    },
  });
  await app.operations.setKillSwitch(o.ownerId, false, 'test');
  await ensureDailyBudget(t.db, o.ownerId, '2026-10-15', 5_000_000);
  contactId = (
    await app.contacts.create(
      t.db,
      o.ownerId,
      { telegramUserId: '555000111', displayName: 'Javlon', verificationSource: 'owner_confirmed_numeric_id' },
      clock.now(),
    )
  ).id;
  await grant();
});
afterEach(async () => {
  await srv.close();
  await app.close();
  await t.drop();
});

const grant = (over: object = {}) =>
  app.contacts.grant(
    t.db,
    o.ownerId,
    contactId,
    { allowCall: true, topicScopes: ['credit-workflow'], allowedHours: { start: '09:00', end: '18:00' }, expiresAt: new Date('2026-12-01T00:00:00Z'), ...over },
    clock.now(),
  );
const planBody = () => ({
  recipientTelegramId: '555000111',
  topic: 'credit-workflow',
  purpose: 'Find out whether the credit-workflow errors are fixed',
  questions: ['Are they fixed?'],
  allowedContext: ['credit workflow incident'],
  forbiddenCommitments: ['payments'],
  language: 'en',
  maxDurationSeconds: 300,
  expiresAt: '2026-10-15T09:00:00.000Z',
});
const api = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, key = `key-${++k}-${Math.random().toString(36).slice(2)}`) =>
  srv.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as object } : {}),
    headers: { authorization: `Bearer ${TOKEN}`, ...(method !== 'GET' ? { 'idempotency-key': key } : {}) },
  });
const n = async (sql: string) => (await t.db.query(sql)).rows[0].n as number;
/** Fault injection at the LAST step of the HTTP transaction: the idempotency response write. */
const failIdempotencyResponseWrite = async (on: boolean) => {
  if (on) {
    await t.db.query(`CREATE OR REPLACE FUNCTION fail_idem() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected fault'; END $$ LANGUAGE plpgsql`);
    await t.db.query(`CREATE TRIGGER fail_idem_trg BEFORE UPDATE ON idempotency_keys FOR EACH ROW EXECUTE FUNCTION fail_idem()`);
  } else await t.db.query(`DROP TRIGGER IF EXISTS fail_idem_trg ON idempotency_keys`);
};

describe('F03 — API effects commit atomically with the idempotency record', () => {
  it('a failure after creating a call request leaves NO request, authorization or job; the retry creates exactly one of each', async () => {
    const key = 'fixed-key-create-1';
    await failIdempotencyResponseWrite(true);
    const bad = await api('POST', '/v1/call-requests', { ...planBody(), ownerExplicitCommand: true }, key);
    expect(bad.statusCode).toBe(500);
    expect(await n('SELECT count(*)::int n FROM call_requests')).toBe(0);
    expect(await n('SELECT count(*)::int n FROM authorizations')).toBe(0);
    expect(await n(`SELECT count(*)::int n FROM jobs WHERE kind='call.dial'`)).toBe(0);
    await failIdempotencyResponseWrite(false);
    const ok1 = await api('POST', '/v1/call-requests', { ...planBody(), ownerExplicitCommand: true }, key);
    const ok2 = await api('POST', '/v1/call-requests', { ...planBody(), ownerExplicitCommand: true }, key);
    expect(ok1.statusCode).toBe(202);
    expect(ok2.headers['idempotent-replayed']).toBe('true');
    expect(await n('SELECT count(*)::int n FROM call_requests')).toBe(1);
    expect(await n('SELECT count(*)::int n FROM authorizations')).toBe(1);
    expect(await n(`SELECT count(*)::int n FROM jobs WHERE kind='call.dial'`)).toBe(1);
  });
  it('a failure after approving rolls the approval back; the retry approves once and enqueues exactly one dial job', async () => {
    const created = await api('POST', '/v1/call-requests', planBody());
    const { authorizationId, planHash } = created.json().data;
    expect(await n(`SELECT count(*)::int n FROM jobs WHERE kind='call.dial'`)).toBe(0);
    const key = 'fixed-key-approve-1';
    await failIdempotencyResponseWrite(true);
    expect((await api('POST', `/v1/authorizations/${authorizationId}/approve`, { planHash }, key)).statusCode).toBe(500);
    expect((await t.db.query('SELECT state FROM authorizations WHERE id=$1', [authorizationId])).rows[0].state).toBe('pending');
    await failIdempotencyResponseWrite(false);
    expect((await api('POST', `/v1/authorizations/${authorizationId}/approve`, { planHash }, key)).statusCode).toBe(202);
    expect((await t.db.query('SELECT state FROM authorizations WHERE id=$1', [authorizationId])).rows[0].state).toBe('approved');
    expect(await n(`SELECT count(*)::int n FROM jobs WHERE kind='call.dial'`)).toBe(1);
  });
  it('a failure after revoking a permission rolls back the revocation and the request cancellation together', async () => {
    const created = await api('POST', '/v1/call-requests', { ...planBody(), ownerExplicitCommand: true });
    expect(created.statusCode).toBe(202);
    await failIdempotencyResponseWrite(true);
    const bad = await api('PATCH', `/v1/contacts/${contactId}/permissions`, {
      allowCall: false,
      topicScopes: ['credit-workflow'],
      expiresAt: '2026-12-01T00:00:00Z',
      revoke: true,
    });
    expect(bad.statusCode).toBe(500);
    expect(await n('SELECT max(version)::int n FROM contact_permissions')).toBe(1);
    expect(await n(`SELECT count(*)::int n FROM call_requests WHERE status='queued'`)).toBe(1);
  });
});

describe('F12 — a cancelled call request is never dialable again', () => {
  const queued = async () => {
    const r = await app.authorizations.createCallRequest(o.ownerId, { ...planBody(), callRequestId: crypto.randomUUID(), ownerId: o.ownerId } as never, {
      ownerExplicitCommand: true,
    });
    await enqueueJob(t.db, {
      ownerId: o.ownerId,
      kind: 'call.dial',
      dueAt: clock.now(),
      dedupeKey: `dial:${r.callRequestId}`,
      payload: { callRequestId: r.callRequestId },
      maxAttempts: 1,
    });
    return r;
  };
  it('kill switch ON then OFF before the job runs: zero dials, job and authorization are invalidated', async () => {
    const r = await queued();
    await app.operations.setKillSwitch(o.ownerId, true, 'stop');
    await app.operations.setKillSwitch(o.ownerId, false, 'resume');
    await app.tick();
    expect(adapter.dials).toHaveLength(0);
    expect((await t.db.query('SELECT status FROM call_requests WHERE id=$1', [r.callRequestId])).rows[0].status).toBe('cancelled');
    expect((await t.db.query('SELECT state FROM authorizations WHERE id=$1', [r.authorizationId])).rows[0].state).toBe('revoked');
    expect(await n(`SELECT count(*)::int n FROM jobs WHERE kind='call.dial' AND status='pending'`)).toBe(0);
  });
  it('revoking then re-granting permissions does not revive an already cancelled request', async () => {
    const r = await queued();
    await app.operations.onPermissionRevoked(o.ownerId, contactId);
    await grant();
    await app.tick();
    expect(adapter.dials).toHaveLength(0);
    expect((await app.orchestrator.dial(o.ownerId, r.callRequestId)).status).toBe('rejected');
    expect(adapter.dials).toHaveLength(0);
  });
  it('even with an approved authorization, a request whose status is not queued is refused (policy input)', async () => {
    const r = await queued();
    await t.db.query(`UPDATE call_requests SET status='cancelled' WHERE id=$1`, [r.callRequestId]);
    const out = await app.orchestrator.dial(o.ownerId, r.callRequestId);
    expect(out).toMatchObject({ status: 'rejected', reason: 'request_not_dialable' });
    expect(adapter.dials).toHaveLength(0);
  });
});

describe('F20 — permission versions are allocated under a contact lock', () => {
  it('concurrent grants all succeed with distinct consecutive versions', async () => {
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => grant()));
    expect(results.every((x) => x.status === 'fulfilled')).toBe(true);
    const v = (await t.db.query('SELECT version FROM contact_permissions WHERE contact_id=$1 ORDER BY version', [contactId])).rows.map((r) => r.version);
    expect(v).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
  it('a revoke racing with grants never fails with a unique violation; the latest committed version decides', async () => {
    const results = await Promise.allSettled([
      grant(),
      app.contacts.revoke(t.db, o.ownerId, contactId, clock.now()),
      grant(),
      app.contacts.revoke(t.db, o.ownerId, contactId, clock.now()),
    ]);
    expect(results.map((x) => x.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
    const v = (await t.db.query('SELECT version FROM contact_permissions WHERE contact_id=$1 ORDER BY version', [contactId])).rows.map((r) => r.version);
    expect(new Set(v).size).toBe(v.length);
  });
});
