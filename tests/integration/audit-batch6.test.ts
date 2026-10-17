import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../support/test-db.js';
import { seedOwner, type SeededOwner } from '../support/seed.js';
import { boot } from '../support/harness.js';
import { FakeClock } from '../../apps/assistant/src/application/clock.js';
import { FakeCallAdapter, FakeMessaging } from '../../apps/assistant/src/testing/fakes.js';
import type { DerivedCapabilities } from '../../apps/assistant/src/modules/calls/capability-evidence.js';
import { ActiveCallRegistry, ensureDailyBudget, settleCallBudget } from '../../apps/assistant/src/modules/operations/operations.service.js';
import { recoverOrphanedCalls } from '../../apps/assistant/src/modules/calls/orchestrator.js';
import type { CallPlanBody } from '@tgvl/contracts';

/** Audit F04 (unknown outcomes keep the account occupied), F13 (budget lifecycle), F14 (owner opt-out stops owner calls). FAKE adapter only. */
const ALL_PASS: DerivedCapabilities = {
  privateOutbound: true,
  privateInbound: false,
  pcmSend: true,
  pcmReceive: true,
  evidenceArtifact: 'TEST-ONLY',
  buildFingerprint: 'test',
  productionCallingAllowed: true,
  ownerCallingAllowed: true,
  thirdPartyConsentMechanismProven: true,
  reasons: [],
};
const HOLD = { run: () => new Promise<never>(() => undefined) }; // a conversation that never ends by itself
const NOW = '2026-10-15T06:00:00Z'; // 11:00 Samarkand
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Poll until `cond()` is true; fail the test (instead of hanging) after `ms`. */
async function until(cond: () => Promise<boolean>, what: string, ms = 3000) {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}
let t: TestDb;
let o: SeededOwner;
beforeEach(async () => {
  t = await createTestDb();
  o = await seedOwner(t.db);
});
afterEach(async () => {
  await t.drop();
});

async function world(
  opts: { now?: string; script?: FakeCallAdapter['script']; extra?: Record<string, unknown>; dailyCap?: number; explicitBudget?: boolean } = {},
) {
  const clock = new FakeClock(new Date(opts.now ?? NOW));
  const adapter = new FakeCallAdapter();
  adapter.script = opts.script ?? { kind: 'answer' };
  const app = boot(t.url, clock, new FakeMessaging(), 'w', {
    callAdapter: adapter,
    deriveCapabilities: () => ALL_PASS,
    ringTimeoutMs: 200,
    ...(opts.dailyCap ? { dailyCapMicroUsd: opts.dailyCap } : {}),
    ...(opts.extra ?? {}),
  });
  await app.operations.setKillSwitch(o.ownerId, false, 'test');
  if (opts.explicitBudget) await ensureDailyBudget(t.db, o.ownerId, '2026-10-15', 5_000_000);
  const contact = await app.contacts.create(
    t.db,
    o.ownerId,
    { telegramUserId: '555000111', displayName: 'Javlon', verificationSource: 'owner_confirmed_numeric_id' },
    clock.now(),
  );
  await app.contacts.grant(
    t.db,
    o.ownerId,
    contact.id,
    { allowCall: true, topicScopes: ['credit-workflow'], allowedHours: null, expiresAt: new Date('2026-12-01T00:00:00Z') },
    clock.now(),
  );
  const body = (over: Partial<CallPlanBody> = {}): CallPlanBody => ({
    callRequestId: crypto.randomUUID(),
    ownerId: o.ownerId,
    recipientTelegramId: '555000111',
    topic: 'credit-workflow',
    purpose: 'Find out whether the credit-workflow errors are fixed',
    questions: ['Are they fixed?'],
    allowedContext: ['credit workflow incident'],
    forbiddenCommitments: ['payments'],
    language: 'en',
    maxDurationSeconds: 300,
    expiresAt: '2026-12-01T00:00:00.000Z',
    ...over,
  });
  const request = (over: Partial<CallPlanBody> = {}) => app.authorizations.createCallRequest(o.ownerId, body(over), { ownerExplicitCommand: true });
  const ownerRequest = () => request({ recipientTelegramId: o.telegramUserId, topic: 'owner-reminder' });
  const callState = async () =>
    (await t.db.query('SELECT state, end_reason FROM calls ORDER BY created_at DESC LIMIT 1')).rows[0] as { state: string; end_reason: string | null };
  const budget = async (day = '2026-10-15') =>
    (
      await t.db.query<{ reserved_micro_usd: string; actual_micro_usd: string }>(
        `SELECT reserved_micro_usd, actual_micro_usd FROM usage_budgets WHERE day=$1`,
        [day],
      )
    ).rows[0];
  return { app, clock, adapter, contact, request, ownerRequest, callState, budget, body };
}

describe('F04 — an unproven call end keeps the account occupied', () => {
  for (const [rec, expected] of [
    ['active', 'outcome_unknown'],
    ['unknown', 'outcome_unknown'],
  ] as const)
    it(`connected call + crash + reconcile "${rec}" -> ${expected}; a second dial is blocked and the reservation is retained`, async () => {
      const w = await world({ script: { kind: 'silent_after_connect' }, extra: { sessionRunner: HOLD }, explicitBudget: true });
      const req = await w.request();
      const first = w.app.orchestrator.dial(o.ownerId, req.callRequestId).catch(() => undefined);
      await until(async () => (await w.callState())?.state === 'connected', 'call state connected');
      w.adapter.reconcileResult = rec;
      await t.db.query(`UPDATE calls SET provider_call_id='p1'`);
      const r = await recoverOrphanedCalls({
        db: w.app.db,
        crypto: w.app.crypto,
        clock: w.clock,
        adapter: w.adapter,
        registry: new ActiveCallRegistry(),
        callBudgetMicroUsd: 1_000_000,
      });
      expect(r.recovered).toBe(1);
      expect((await w.callState()).state).toBe(expected);
      const second = await w.request();
      expect(await w.app.orchestrator.dial(o.ownerId, second.callRequestId)).toMatchObject({ status: 'rejected', reason: 'active_call_exists' });
      expect((await w.budget())?.reserved_micro_usd).toBe('1000000'); // not released until the unknown call is intentionally resolved
      for (const c of w.app.registry.list(o.ownerId)) await c.end('cancelled');
      await first;
      await w.app.close();
    });
  it('connected call + crash + reconcile "ended" is proven over: account freed, reservation released', async () => {
    const w = await world({ script: { kind: 'silent_after_connect' }, extra: { sessionRunner: HOLD }, explicitBudget: true });
    const req = await w.request();
    const first = w.app.orchestrator.dial(o.ownerId, req.callRequestId).catch(() => undefined);
    await until(async () => (await w.callState())?.state === 'connected', 'call state connected');
    w.adapter.reconcileResult = 'ended';
    await t.db.query(`UPDATE calls SET provider_call_id='p1'`);
    await recoverOrphanedCalls({
      db: w.app.db,
      crypto: w.app.crypto,
      clock: w.clock,
      adapter: w.adapter,
      registry: new ActiveCallRegistry(),
      callBudgetMicroUsd: 1_000_000,
    });
    expect(['ended', 'failed']).toContain((await w.callState()).state);
    expect((await w.budget())?.reserved_micro_usd).toBe('0');
    for (const c of w.app.registry.list(o.ownerId)) await c.end('cancelled');
    await first;
    await w.app.close();
  });
  it('hangup rejection + a permanently silent event stream finish supervision within a deadline and PERSIST the uncertainty', async () => {
    const w = await world({
      script: { kind: 'silent_after_connect' },
      extra: { callTimeouts: { eventIdleMs: 150, hangupMs: 100, dialMs: 1000 } },
      explicitBudget: true,
    });
    w.adapter.endShouldFail = true;
    const req = await w.request();
    const t0 = Date.now();
    const out = await w.app.orchestrator.dial(o.ownerId, req.callRequestId);
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(out.status).toBe('outcome_unknown');
    expect((await w.callState()).state).toBe('outcome_unknown');
    expect((await w.budget())?.reserved_micro_usd).toBe('1000000');
    const again = await w.request();
    expect(await w.app.orchestrator.dial(o.ownerId, again.callRequestId)).toMatchObject({ status: 'rejected', reason: 'active_call_exists' });
    await w.app.close();
  });
  it('a silent stream with a hangup the provider later CONFIRMS (reconcile ended) is proven and frees the account', async () => {
    const w = await world({
      script: { kind: 'silent_after_connect' },
      extra: { callTimeouts: { eventIdleMs: 150, hangupMs: 100, dialMs: 1000 } },
      explicitBudget: true,
    });
    w.adapter.endSilent = true;
    w.adapter.reconcileResult = 'ended';
    const req = await w.request();
    const out = await w.app.orchestrator.dial(o.ownerId, req.callRequestId);
    expect(out.status).toBe('finished');
    expect(['ended', 'failed']).toContain((await w.callState()).state);
    expect((await w.budget())?.reserved_micro_usd).toBe('0');
    await w.app.close();
  });
  it('a dial that never returns is bounded by a dial deadline and ends as outcome_unknown', async () => {
    const w = await world({ script: { kind: 'hang_in_dial' }, extra: { callTimeouts: { dialMs: 120 } }, explicitBudget: true });
    const req = await w.request();
    const t0 = Date.now();
    const out = await w.app.orchestrator.dial(o.ownerId, req.callRequestId);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(out.status).toBe('outcome_unknown');
    await w.app.close();
  });
  it('a kill switch pressed during dial is not lost in the dial-to-supervisor handover', async () => {
    const w = await world({ script: { kind: 'dial_ignores_abort', delayMs: 250 }, extra: { sessionRunner: HOLD }, explicitBudget: true });
    const req = await w.request();
    const dialing = w.app.orchestrator.dial(o.ownerId, req.callRequestId);
    await sleep(60);
    await w.app.operations.setKillSwitch(o.ownerId, true, 'stop now'); // aborts the dial phase; the adapter ignores it
    const out = await dialing;
    expect(w.adapter.ended.map((e) => e.reason)).toEqual(['cancelled']); // the call that appeared after the abort was ended at once
    expect(out.status).toBe('finished');
    await w.app.close();
  });
});

describe('F13 — budget lifecycle', () => {
  it('creates each local day lazily: two local midnights without a restart still allow capped calls, one call per day', async () => {
    // Each call spends the whole day's cap, so a second call on the same local day must be refused.
    const spendAll = { run: async () => ({ endReason: 'completed' as const, usageMicroUsd: 1_000_000 }) };
    const w = await world({ now: '2026-10-15T18:30:00Z', dailyCap: 1_000_000, extra: { sessionRunner: spendAll } }); // 23:30 local, no pre-created budget row
    expect((await w.app.orchestrator.dial(o.ownerId, (await w.request()).callRequestId)).status).toBe('finished');
    expect(await w.app.orchestrator.dial(o.ownerId, (await w.request()).callRequestId)).toMatchObject({ status: 'rejected', reason: 'budget_not_reserved' });
    w.clock.set('2026-10-15T19:30:00Z'); // 00:30 next local day
    expect((await w.app.orchestrator.dial(o.ownerId, (await w.request()).callRequestId)).status).toBe('finished');
    w.clock.set('2026-10-16T19:30:00Z'); // and the day after, still no restart
    expect((await w.app.orchestrator.dial(o.ownerId, (await w.request()).callRequestId)).status).toBe('finished');
    expect((await t.db.query('SELECT count(*)::int n FROM usage_budgets')).rows[0].n).toBe(3);
    await w.app.close();
  });
  it('recovery across midnight releases the ORIGINAL reservation exactly once', async () => {
    const w = await world({ now: '2026-10-15T18:30:00Z', script: { kind: 'hang_in_dial' }, extra: { callTimeouts: { dialMs: 60_000 } }, dailyCap: 5_000_000 });
    const req = await w.request();
    const dialing = w.app.orchestrator.dial(o.ownerId, req.callRequestId).catch(() => undefined);
    await until(async () => (await w.callState())?.state === 'dialing', 'call state dialing');
    expect((await w.budget('2026-10-15'))?.reserved_micro_usd).toBe('1000000');
    await t.db.query(`UPDATE calls SET provider_call_id='p1'`);
    w.adapter.reconcileResult = 'ended';
    w.clock.set('2026-10-15T19:30:00Z'); // after local midnight
    const recover = () =>
      recoverOrphanedCalls({
        db: w.app.db,
        crypto: w.app.crypto,
        clock: w.clock,
        adapter: w.adapter,
        registry: new ActiveCallRegistry(),
        callBudgetMicroUsd: 1_000_000,
      });
    expect((await recover()).recovered).toBe(1);
    expect((await w.budget('2026-10-15'))?.reserved_micro_usd).toBe('0'); // the original day, not "today"
    expect((await recover()).recovered).toBe(0);
    expect((await w.budget('2026-10-15'))?.reserved_micro_usd).toBe('0'); // not released twice
    for (const c of w.app.registry.list(o.ownerId)) await c.end('cancelled');
    await dialing;
    await w.app.close();
  });
  it('an actual charge reduces the remaining budget and cannot be settled twice', async () => {
    const runner = { run: async () => ({ endReason: 'completed' as const, usageMicroUsd: 300_000 }) };
    const w = await world({ extra: { sessionRunner: runner }, explicitBudget: true });
    const out = await w.app.orchestrator.dial(o.ownerId, (await w.request()).callRequestId);
    expect(out.status).toBe('finished');
    expect(await w.budget()).toMatchObject({ reserved_micro_usd: '0', actual_micro_usd: '300000' });
    const callId = (await t.db.query<{ id: string }>('SELECT id FROM calls')).rows[0]!.id;
    expect(await settleCallBudget(t.db, o.ownerId, callId, 999_999, w.clock.now())).toBe(false); // retry: no double settlement
    expect(await w.budget()).toMatchObject({ reserved_micro_usd: '0', actual_micro_usd: '300000' });
    await w.app.close();
  });
  it('an unknown outcome keeps its reservation until the operator resolves it, which settles exactly once', async () => {
    const w = await world({ script: { kind: 'unknown_outcome' }, explicitBudget: true });
    const out = await w.app.orchestrator.dial(o.ownerId, (await w.request()).callRequestId);
    expect(out.status).toBe('outcome_unknown');
    expect((await w.budget())?.reserved_micro_usd).toBe('1000000');
    const callId = (await t.db.query<{ id: string }>('SELECT id FROM calls')).rows[0]!.id;
    await w.app.operations.resolveUnknownCall(o.ownerId, callId, { note: 'checked the phone: no live call', now: w.clock.now() });
    expect((await w.callState()).state).toBe('ended');
    expect((await w.budget())?.reserved_micro_usd).toBe('0');
    await expect(w.app.operations.resolveUnknownCall(o.ownerId, callId, { note: 'again', now: w.clock.now() })).rejects.toMatchObject({
      code: 'invalid_state',
    });
    await w.app.close();
  });
});

describe('F14 — "stop calling me" stops ALL assistant calls (owner and contacts), within seconds', () => {
  it('cancels every queued call, ends a live owner call, and blocks future owner AND contact calls', async () => {
    const w = await world({ script: { kind: 'silent_after_connect' }, extra: { sessionRunner: HOLD }, explicitBudget: true });
    // 1) a live OWNER call and a queued second owner call
    const live = await w.ownerRequest();
    const dialing = w.app.orchestrator.dial(o.ownerId, live.callRequestId).catch(() => undefined);
    await until(async () => (await w.callState())?.state === 'connected', 'call state connected');
    expect(w.app.registry.list(o.ownerId).map((c) => c.kind)).toEqual(['owner_call']);
    const queued = await w.ownerRequest();
    const contactReq = await w.request();
    // 2) the owner says it
    const reply = await w.app.intake.handle({
      accountId: o.accountId,
      updateKey: 'msg:optout-1',
      providerMessageId: '1',
      senderTelegramId: o.telegramUserId,
      chat: { type: 'private', id: o.telegramUserId },
      receivedAt: new Date(NOW),
      text: 'stop calling me',
    });
    expect(reply).toEqual({ status: 'handled', intent: 'stop_calling' });
    await w.app.tick();
    expect(w.app.messaging.sent.some((m) => /all calls are stopped/i.test(m.text))).toBe(true); // the reply states the scope
    // 3) effects
    expect(w.adapter.ended.map((e) => e.reason)).toEqual(['cancelled']); // the live owner call was ended
    expect((await t.db.query('SELECT status FROM call_requests WHERE id=$1', [queued.callRequestId])).rows[0].status).toBe('cancelled');
    await dialing;
    const after = await w.ownerRequest();
    expect(await w.app.orchestrator.dial(o.ownerId, after.callRequestId)).toMatchObject({ status: 'rejected', reason: 'owner_opted_out' });
    // contact calls are covered too: the queued contact request is cancelled and its authorization revoked
    const contactRow = await t.db.query('SELECT status FROM call_requests WHERE id=$1', [contactReq.callRequestId]);
    expect(contactRow.rows[0].status).toBe('cancelled');
    expect((await t.db.query('SELECT state FROM authorizations WHERE id=$1', [contactReq.authorizationId])).rows[0].state).toBe('revoked');
    const contactAfter = await w.request();
    expect(await w.app.orchestrator.dial(o.ownerId, contactAfter.callRequestId)).toMatchObject({ status: 'rejected', reason: 'owner_opted_out' });
    await w.app.close();
  });
  it('a live CONTACT call is ended by the opt-out too, and promptly', async () => {
    const w = await world({ script: { kind: 'silent_after_connect' }, extra: { sessionRunner: HOLD }, explicitBudget: true });
    const dialing = w.app.orchestrator.dial(o.ownerId, (await w.request()).callRequestId).catch(() => undefined);
    await until(async () => (await w.callState())?.state === 'connected', 'call state connected');
    const started = Date.now();
    await w.app.intake.handle({
      accountId: o.accountId,
      updateKey: 'msg:optout-2',
      providerMessageId: '2',
      senderTelegramId: o.telegramUserId,
      chat: { type: 'private', id: o.telegramUserId },
      receivedAt: new Date(NOW),
      text: "don't call me",
    });
    expect(w.adapter.ended.map((e) => e.reason)).toEqual(['cancelled']);
    expect(Date.now() - started).toBeLessThan(2000); // stopping is not a timer: it happens within the command itself
    await dialing;
    await w.app.close();
  });
});
