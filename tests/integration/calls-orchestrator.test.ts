import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../support/test-db.js';
import { seedOwner, type SeededOwner } from '../support/seed.js';
import { boot } from '../support/harness.js';
import { FakeClock } from '../../apps/assistant/src/application/clock.js';
import { FakeCallAdapter, FakeMessaging } from '../../apps/assistant/src/testing/fakes.js';
import type { DerivedCapabilities } from '../../apps/assistant/src/modules/calls/capability-evidence.js';
import { ensureDailyBudget } from '../../apps/assistant/src/modules/operations/operations.service.js';
import type { CallPlanBody } from '@tgvl/contracts';

/**
 * The orchestrator is exercised against a FAKE adapter and TEST-ONLY "all gates passed" capabilities. This verifies the
 * control logic (policy, state machine, uncertainty handling). It says NOTHING about real Telegram calling.
 */
const ALL_PASS: DerivedCapabilities = { privateOutbound: true, privateInbound: false, pcmSend: true, pcmReceive: true, evidenceArtifact: 'TEST-ONLY', buildFingerprint: 'test', productionCallingAllowed: true, thirdPartyConsentMechanismProven: true, reasons: [] };

const NOW = '2026-10-15T06:00:00Z'; // 11:00 Samarkand
let t: TestDb;
let o: SeededOwner;
beforeEach(async () => { t = await createTestDb(); o = await seedOwner(t.db); });
afterEach(async () => { await t.drop(); });

async function world(opts: { script?: FakeCallAdapter['script']; caps?: DerivedCapabilities; killOff?: boolean; budget?: number; ringTimeoutMs?: number; sessionRunner?: any } = {}) {
  const clock = new FakeClock(new Date(NOW));
  const adapter = new FakeCallAdapter();
  if (opts.script) adapter.script = opts.script;
  const app = boot(t.url, clock, new FakeMessaging(), 'w', { callAdapter: adapter, deriveCapabilities: () => opts.caps ?? ALL_PASS, ringTimeoutMs: opts.ringTimeoutMs ?? 200, ...(opts.sessionRunner ? { sessionRunner: opts.sessionRunner } : {}) });
  if (opts.killOff !== false) await app.operations.setKillSwitch(o.ownerId, false, 'test');
  await ensureDailyBudget(t.db, o.ownerId, '2026-10-15', opts.budget ?? 5_000_000);
  const contact = await app.contacts.create(t.db, o.ownerId, { telegramUserId: '555000111', displayName: 'Javlon', verificationSource: 'owner_confirmed_numeric_id' }, clock.now());
  const grant = (over: Partial<Parameters<typeof app.contacts.grant>[3]> = {}) =>
    app.contacts.grant(t.db, o.ownerId, contact.id, { allowCall: true, topicScopes: ['credit-workflow'], allowedHours: { start: '09:00', end: '18:00' }, expiresAt: new Date('2026-12-01T00:00:00Z'), ...over }, clock.now());
  await grant();
  let n = 0;
  const body = (over: Partial<CallPlanBody> = {}): CallPlanBody => ({
    callRequestId: crypto.randomUUID(), ownerId: o.ownerId, recipientTelegramId: '555000111', topic: 'credit-workflow',
    purpose: 'Find out whether the credit-workflow errors are fixed', questions: ['Are they fixed?', 'What blocks the fix?'],
    allowedContext: ['credit workflow incident'], forbiddenCommitments: ['payments'], language: 'en', maxDurationSeconds: 300,
    expiresAt: '2026-10-15T09:00:00.000Z', ...over, ...(n++ >= 0 ? {} : {}),
  });
  const request = (over: Partial<CallPlanBody> = {}) => app.authorizations.createCallRequest(o.ownerId, body(over), { ownerExplicitCommand: true });
  const callCount = async () => (await t.db.query('SELECT count(*)::int n FROM calls')).rows[0].n as number;
  const rows = async () => (await t.db.query('SELECT state, end_reason FROM calls ORDER BY created_at')).rows;
  return { app, clock, adapter, contact, grant, request, body, callCount, rows };
}

describe('happy-path control flow (fake adapter; conversation layer intentionally absent)', () => {
  it('dials once, consumes the single-use authorization, settles the budget, ends safely and tells the owner honestly', async () => {
    const w = await world({ script: { kind: 'answer' } });
    const req = await w.request();
    const out = await w.app.orchestrator.dial(o.ownerId, req.callRequestId);
    expect(out).toMatchObject({ status: 'finished', state: 'ended', endReason: 'cancelled' });
    expect(w.adapter.dials).toHaveLength(1);
    const auth = await t.db.query('SELECT state FROM authorizations WHERE id=$1', [req.authorizationId]);
    expect(auth.rows[0].state).toBe('consumed');
    const b = await t.db.query('SELECT reserved_micro_usd, actual_micro_usd FROM usage_budgets WHERE owner_id=$1', [o.ownerId]);
    expect(b.rows[0]).toMatchObject({ reserved_micro_usd: '0', actual_micro_usd: '0' });
    const rep = await t.db.query('SELECT status, complete, structured_result FROM call_reports');
    expect(rep.rows[0].complete).toBe(false); // truthful: no conversation happened
    await w.app.tick();
    expect(w.app.messaging.sent.at(-1)?.text).toMatch(/No conversation took place/);
    // The authorization cannot be reused: a second dial of the same request is refused and places no call.
    const again = await w.app.orchestrator.dial(o.ownerId, req.callRequestId);
    expect(again).toMatchObject({ status: 'rejected', reason: 'authorization_not_approved' });
    expect(w.adapter.dials).toHaveLength(1);
    await w.app.close();
  });

  it('a pending (unapproved) brief is not dialable; approving the exact hash makes it dialable', async () => {
    const w = await world();
    const req = await w.app.authorizations.createCallRequest(o.ownerId, w.body(), {});
    expect(req.state).toBe('pending');
    expect(await w.app.orchestrator.dial(o.ownerId, req.callRequestId)).toMatchObject({ status: 'rejected', reason: 'authorization_not_approved' });
    await expect(w.app.authorizations.approve(o.ownerId, req.authorizationId, 'e'.repeat(64))).rejects.toMatchObject({ code: 'plan_changed' });
    await w.app.authorizations.approve(o.ownerId, req.authorizationId, req.planHash);
    expect((await w.app.orchestrator.dial(o.ownerId, req.callRequestId)).status).toBe('finished');
    expect(w.adapter.dials).toHaveLength(1);
    await w.app.close();
  });
});

describe('A04 — denials place no call and consume nothing', () => {
  const expectDenied = async (w: Awaited<ReturnType<typeof world>>, id: string, reason: string) => {
    expect(await w.app.orchestrator.dial(o.ownerId, id)).toMatchObject({ status: 'rejected', reason });
    expect(w.adapter.dials).toHaveLength(0);
    expect(await w.callCount()).toBe(0);
  };
  it('revoked permission', async () => {
    const w = await world();
    const req = await w.request();
    await w.app.contacts.revoke(t.db, o.ownerId, w.contact.id, w.clock.now());
    await expectDenied(w, req.callRequestId, 'permission_revoked');
    const a = await t.db.query('SELECT state FROM authorizations WHERE id=$1', [req.authorizationId]);
    expect(a.rows[0].state).toBe('approved'); // refusal did not burn the authorization
    await w.app.close();
  });
  it('permission changed after approval (stale version)', async () => {
    const w = await world();
    const req = await w.request();
    await w.grant({ topicScopes: ['credit-workflow', 'invoices'] }); // v2
    await expectDenied(w, req.callRequestId, 'permission_version_stale');
    await w.app.close();
  });
  it('expired permission', async () => {
    const w = await world();
    const req = await w.request();
    w.clock.set('2026-12-02T00:00:00Z');
    await expectDenied(w, req.callRequestId, 'authorization_expired');
    await w.app.close();
  });
  it('plan tampered after approval (hash mismatch)', async () => {
    const w = await world();
    const req = await w.request();
    await t.db.query(`UPDATE call_requests SET plan = jsonb_set(plan, '{purpose}', '"Ask for the bank password"') WHERE id=$1`, [req.callRequestId]);
    await expectDenied(w, req.callRequestId, 'plan_hash_mismatch');
    await w.app.close();
  });
  it('unverified / ambiguous contact cannot even get a brief', async () => {
    const w = await world();
    await t.db.query(`UPDATE contacts SET verified_at=NULL, verification_source=NULL WHERE id=$1`, [w.contact.id]);
    await expect(w.request()).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(w.app.authorizations.createCallRequest(o.ownerId, w.body({ recipientTelegramId: '999999999' }), { ownerExplicitCommand: true })).rejects.toMatchObject({ code: 'not_found' });
    await w.app.close();
  });
  it('topic not granted to the contact', async () => {
    const w = await world();
    const req = await w.request({ topic: 'salary' });
    await expectDenied(w, req.callRequestId, 'topic_not_permitted');
    await w.app.close();
  });
  it('outside the hours the contact allows', async () => {
    const w = await world();
    const req = await w.request({ expiresAt: '2026-10-16T00:00:00.000Z' });
    w.clock.set('2026-10-15T14:00:00Z'); // 19:00 local
    await expectDenied(w, req.callRequestId, 'outside_allowed_hours');
    await w.app.close();
  });
  it('real calling not verified for this build (no evidence) — even with everything else perfect', async () => {
    const w = await world({ caps: { ...ALL_PASS, productionCallingAllowed: false, reasons: ['G0-B: BLOCKED_EXTERNAL'] } });
    const req = await w.request();
    await expectDenied(w, req.callRequestId, 'calling_not_verified');
    await w.app.close();
  });
  it('third-party consent mechanism unproven => contact calls disabled', async () => {
    const w = await world({ caps: { ...ALL_PASS, thirdPartyConsentMechanismProven: false } });
    const req = await w.request();
    await expectDenied(w, req.callRequestId, 'consent_mechanism_unproven');
    await w.app.close();
  });
  it('the default (disabled) wiring can never dial', async () => {
    const clock = new FakeClock(new Date(NOW));
    const app = boot(t.url, clock);
    await app.operations.setKillSwitch(o.ownerId, false, 'test');
    await ensureDailyBudget(t.db, o.ownerId, '2026-10-15', 5_000_000);
    const c = await app.contacts.create(t.db, o.ownerId, { telegramUserId: '555000111', displayName: 'J', verificationSource: 'owner_confirmed_numeric_id' }, clock.now());
    await app.contacts.grant(t.db, o.ownerId, c.id, { allowCall: true, topicScopes: ['credit-workflow'], expiresAt: new Date('2026-12-01T00:00:00Z') }, clock.now());
    const req = await app.authorizations.createCallRequest(o.ownerId, { callRequestId: crypto.randomUUID(), ownerId: o.ownerId, recipientTelegramId: '555000111', topic: 'credit-workflow', purpose: 'check status please', questions: [], allowedContext: [], forbiddenCommitments: [], language: 'en', maxDurationSeconds: 60, expiresAt: '2026-10-15T09:00:00.000Z' }, { ownerExplicitCommand: true });
    expect(await app.orchestrator.dial(o.ownerId, req.callRequestId)).toMatchObject({ status: 'rejected', reason: 'calling_not_verified' });
    await app.close();
  });
  it('the kill switch is ON by default and blocks dialing', async () => {
    const w = await world({ killOff: false });
    const req = await w.request();
    await expectDenied(w, req.callRequestId, 'kill_switch_on');
    await w.app.close();
  });
  it('budget exhausted', async () => {
    const w = await world({ budget: 500_000 }); // cap below the 1,000,000 reservation
    const req = await w.request();
    await expectDenied(w, req.callRequestId, 'budget_not_reserved');
    await w.app.close();
  });
});

describe('A11 — uncertain dial outcome: reconcile, never blindly redial', () => {
  it('timeout after sending => outcome_unknown, account stays occupied, owner told, explicit fresh authority required', async () => {
    const w = await world({ script: { kind: 'unknown_outcome' } });
    const req = await w.request();
    expect(await w.app.orchestrator.dial(o.ownerId, req.callRequestId)).toMatchObject({ status: 'outcome_unknown' });
    expect(w.adapter.dials).toHaveLength(1);
    expect((await w.rows())[0]).toMatchObject({ state: 'outcome_unknown', end_reason: 'outcome_unknown' });
    await w.app.tick();
    expect(w.app.messaging.sent.at(-1)?.text).toMatch(/NOT retry on my own/);
    // Same request again: refused (authorization consumed). A NEW request: refused while the account is occupied.
    expect((await w.app.orchestrator.dial(o.ownerId, req.callRequestId)).status).toBe('rejected');
    const fresh = await w.request();
    expect(await w.app.orchestrator.dial(o.ownerId, fresh.callRequestId)).toMatchObject({ status: 'rejected', reason: 'active_call_exists' });
    expect(w.adapter.dials).toHaveLength(1); // no redial, ever
    await w.app.close();
  });
  it('reconcile says the call ended => failed (transport_error), account released', async () => {
    const w = await world({ script: { kind: 'unknown_outcome', providerCallId: 'p-1' } });
    w.adapter.reconcileResult = 'ended';
    const req = await w.request();
    expect(await w.app.orchestrator.dial(o.ownerId, req.callRequestId)).toMatchObject({ status: 'finished', state: 'failed', endReason: 'transport_error' });
    await w.app.close();
  });
  it('reconcile says still active but we hold no handle => stays outcome_unknown (never assumes it is safe)', async () => {
    const w = await world({ script: { kind: 'unknown_outcome', providerCallId: 'p-2' } });
    w.adapter.reconcileResult = 'active';
    const req = await w.request();
    expect(await w.app.orchestrator.dial(o.ownerId, req.callRequestId)).toMatchObject({ status: 'outcome_unknown' });
    await w.app.close();
  });
  it('a crash/hang in dial that is aborted counts as unknown, not as "not placed"', async () => {
    const w = await world({ script: { kind: 'hang_in_dial' } });
    const req = await w.request();
    const p = w.app.orchestrator.dial(o.ownerId, req.callRequestId);
    await new Promise((r) => setTimeout(r, 50));
    await w.app.operations.setKillSwitch(o.ownerId, true, 'abort pending dial');
    expect(await p).toMatchObject({ status: 'outcome_unknown' });
    await w.app.close();
  });
});

describe('A14 — refusals, busy, privacy, flood wait: terminal, notified, never retried', () => {
  it.each([
    ['declined', 'declined'], ['busy', 'busy'], ['no_answer', 'no_answer'], ['privacy_restricted', 'failed'],
  ] as const)('%s', async (reason, state) => {
    const w = await world({ script: { kind: 'reject', reason } });
    const req = await w.request();
    expect(await w.app.orchestrator.dial(o.ownerId, req.callRequestId)).toMatchObject({ status: 'finished', state, endReason: reason });
    expect(w.adapter.dials).toHaveLength(1);
    expect((await t.db.query('SELECT reserved_micro_usd FROM usage_budgets')).rows[0].reserved_micro_usd).toBe('0');
    await w.app.tick();
    expect(w.app.messaging.sent.length).toBeGreaterThan(0);
    // No automatic redial: a worker tick must not dial again.
    await w.app.tick();
    expect(w.adapter.dials).toHaveLength(1);
    await w.app.close();
  });
  it('flood wait is surfaced, terminal, and not retried in a loop', async () => {
    const w = await world({ script: { kind: 'reject', reason: 'transport_error', retryAfterSeconds: 3600 } });
    const req = await w.request();
    expect(await w.app.orchestrator.dial(o.ownerId, req.callRequestId)).toMatchObject({ status: 'finished', state: 'failed' });
    for (let i = 0; i < 3; i++) await w.app.tick();
    expect(w.adapter.dials).toHaveLength(1);
    await w.app.close();
  });
  it('ringing timeout ends an unanswered call as no_answer', async () => {
    const w = await world({ script: { kind: 'no_answer' }, ringTimeoutMs: 60 });
    const req = await w.request();
    expect(await w.app.orchestrator.dial(o.ownerId, req.callRequestId)).toMatchObject({ status: 'finished', state: 'no_answer', endReason: 'no_answer' });
    expect(w.adapter.ended.map((e) => e.reason)).toEqual(['no_answer']);
    await w.app.close();
  });
});

describe('A12 — kill switch / revocation during a live call', () => {
  const holdingRunner = { run: () => new Promise(() => { /* conversation that never ends by itself */ }) };
  it('kill switch ends the live call fast, blocks new calls, and persists independently of the model', async () => {
    const w = await world({ script: { kind: 'answer' }, sessionRunner: holdingRunner });
    const req = await w.request();
    const dialP = w.app.orchestrator.dial(o.ownerId, req.callRequestId);
    for (let i = 0; i < 100 && !(await w.rows())[0]?.state.match(/connected/); i++) await new Promise((r) => setTimeout(r, 10));
    expect((await w.rows())[0].state).toBe('connected');
    const r = await w.app.operations.setKillSwitch(o.ownerId, true, 'emergency');
    expect(r.terminated).toBe(1);
    expect(r.elapsedMs).toBeLessThan(2000); // spec target: stop within 2 s on a healthy local control path
    expect(await dialP).toMatchObject({ status: 'finished', state: 'ended', endReason: 'cancelled' });
    const next = await w.request();
    expect(await w.app.orchestrator.dial(o.ownerId, next.callRequestId)).toMatchObject({ status: 'rejected', reason: 'kill_switch_on' });
    expect((await t.db.query('SELECT calling_kill_switch FROM operation_settings')).rows[0].calling_kill_switch).toBe(true);
    await w.app.close();
  });
  it('revoking the contact mid-call terminates that call (consent_withdrawn) and cancels queued requests', async () => {
    const w = await world({ script: { kind: 'answer' }, sessionRunner: holdingRunner });
    const req = await w.request();
    const queued = await w.request();
    const dialP = w.app.orchestrator.dial(o.ownerId, req.callRequestId);
    for (let i = 0; i < 100 && !(await w.rows())[0]?.state.match(/connected/); i++) await new Promise((r) => setTimeout(r, 10));
    await w.app.contacts.revoke(t.db, o.ownerId, w.contact.id, w.clock.now());
    const r = await w.app.operations.onPermissionRevoked(o.ownerId, w.contact.id);
    expect(r.terminated).toBe(1);
    expect(await dialP).toMatchObject({ status: 'finished', endReason: 'consent_withdrawn' });
    const q = await t.db.query('SELECT status FROM call_requests WHERE id=$1', [queued.callRequestId]);
    expect(q.rows[0].status).toBe('cancelled');
    await w.app.close();
  });
});

describe('A13 / state-machine robustness', () => {
  it('event stream dying after answer => controlled end as transport_error, no false completion', async () => {
    const w = await world({ script: { kind: 'event_stream_dies' }, ringTimeoutMs: 5000 });
    const req = await w.request();
    const out = await w.app.orchestrator.dial(o.ownerId, req.callRequestId);
    expect(out).toMatchObject({ status: 'finished', endReason: 'transport_error' });
    expect(out.status === 'finished' && out.state).not.toBe('active');
    expect((await t.db.query('SELECT complete FROM call_reports')).rows[0].complete).toBe(false);
    await w.app.close();
  });
  it('duplicate provider events are applied once', async () => {
    const w = await world({ script: { kind: 'duplicate_events' } });
    const req = await w.request();
    await w.app.orchestrator.dial(o.ownerId, req.callRequestId);
    const ev = await t.db.query(`SELECT provider_event_key, count(*)::int n FROM call_events GROUP BY 1 HAVING count(*) > 1`);
    expect(ev.rows).toHaveLength(0);
    await w.app.close();
  });
  it('two concurrent dials: exactly one proceeds, the other is refused (one active call per account)', async () => {
    const w = await world({ script: { kind: 'answer' }, sessionRunner: { run: () => new Promise((r) => setTimeout(() => r({ endReason: 'completed' }), 150)) } });
    const a = await w.request();
    const b = await w.request();
    const [ra, rb] = await Promise.all([w.app.orchestrator.dial(o.ownerId, a.callRequestId), w.app.orchestrator.dial(o.ownerId, b.callRequestId)]);
    const outcomes = [ra.status, rb.status].sort();
    expect(outcomes).toEqual(['finished', 'rejected']);
    expect(w.adapter.dials).toHaveLength(1);
    await w.app.close();
  });
  it('a rolled-back refusal leaves no half-consumed state (authorization approved, budget untouched, no call row)', async () => {
    const w = await world({ budget: 500_000 });
    const req = await w.request();
    await w.app.orchestrator.dial(o.ownerId, req.callRequestId);
    expect(await w.callCount()).toBe(0);
    expect((await t.db.query('SELECT state FROM authorizations WHERE id=$1', [req.authorizationId])).rows[0].state).toBe('approved');
    expect((await t.db.query('SELECT reserved_micro_usd FROM usage_budgets')).rows[0].reserved_micro_usd).toBe('0');
    await w.app.close();
  });
});
