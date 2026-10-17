import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestDb, type TestDb } from '../support/test-db.js';
import { seedOwner, type SeededOwner } from '../support/seed.js';
import { boot } from '../support/harness.js';
import { FakeClock } from '../../apps/assistant/src/application/clock.js';
import { buildServer } from '../../apps/assistant/src/http/server.js';
import { createLogger } from '../../apps/assistant/src/infrastructure/observability/logger.js';

/** Audit P2 batch: F19 failed-auth load, F17 outbound length, F18 truthful config, F16 clarification, F15 recovery. */
const TOKEN = 'T'.repeat(40);
let t: TestDb;
let o: SeededOwner;
let app: ReturnType<typeof boot>;
let srv: FastifyInstance;
let clock: FakeClock;
beforeEach(async () => {
  t = await createTestDb();
  o = await seedOwner(t.db);
  clock = new FakeClock(new Date('2026-10-15T06:00:00Z'));
  app = boot(t.url, clock);
  srv = await buildServer({
    app,
    log: createLogger('silent'),
    adminTokens: [TOKEN],
    runtime: {
      messagingAdapter: 'fake',
      interpreterAdapter: 'rules',
      callAdapter: 'disabled',
      callsEnabled: false,
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
const get = (url: string, token: string | null = TOKEN) => srv.inject({ method: 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {} });

describe('F19 — failed API authentication cannot amplify database or log load', () => {
  it('bounds audit writes and throttles responses under a flood, while authenticated requests stay responsive', async () => {
    const codes = new Map<number, number>();
    for (let i = 0; i < 300; i++) {
      const r = await get('/v1/tasks', `wrong-token-${i}-wrong-token-wrong-token-1234`);
      codes.set(r.statusCode, (codes.get(r.statusCode) ?? 0) + 1);
    }
    const audits = await t.db.query(`SELECT count(*)::int n FROM audit_events WHERE action='admin_api' AND reason_code='bad_token'`);
    expect(audits.rows[0].n).toBeLessThanOrEqual(6);
    expect(codes.get(401)).toBeGreaterThan(0);
    expect(codes.get(429)).toBeGreaterThan(0); // throttled answers are cheap: no database work
    // The authenticated owner is never throttled by someone else's failures.
    expect((await get('/v1/tasks')).statusCode).toBe(200);
    const ks = await srv.inject({
      method: 'POST',
      url: '/v1/operations/kill-switch',
      payload: { on: true, reason: 'x' },
      headers: { authorization: `Bearer ${TOKEN}`, 'idempotency-key': 'ks-flood-test-1' },
    });
    expect(ks.statusCode).toBe(200);
  });
  it('writes ONE summary row for the suppressed failures when the window rolls over, and audits new failures again', async () => {
    for (let i = 0; i < 100; i++) await get('/v1/tasks', `bad-${i}-bad-bad-bad-bad-bad-bad-bad-bad-bad`);
    clock.advanceMs(61_000);
    await get('/v1/tasks', 'another-wrong-token-another-wrong-token-1');
    const sum = await t.db.query(`SELECT metadata FROM audit_events WHERE reason_code='bad_token_suppressed'`);
    expect(sum.rows).toHaveLength(1);
    expect(sum.rows[0].metadata.count).toBeGreaterThan(50);
    const audits = await t.db.query(`SELECT count(*)::int n FROM audit_events WHERE reason_code='bad_token'`);
    expect(audits.rows[0].n).toBeLessThanOrEqual(12);
  });
  it('the HTTP server has connection and request deadlines', () => {
    expect(srv.initialConfig.connectionTimeout).toBeGreaterThan(0);
    expect(srv.initialConfig.requestTimeout).toBeGreaterThan(0);
    expect(srv.initialConfig.keepAliveTimeout).toBeLessThanOrEqual(30_000);
  });
});

describe('F17 — long replies are chunked, retried without duplicates, and permanent failures are not retried', () => {
  const LONG = (i: number) => `Vazifa №${i} — ${'uzun sarlavha '.repeat(8)}😀 ${i}`;
  it('a 50-item list with long Unicode titles is split within the provider limit, numbering is kept, retries add no duplicates', async () => {
    const clock2 = new FakeClock(new Date('2026-10-15T06:00:00Z'));
    const flaky = new (await import('../../apps/assistant/src/testing/fakes.js')).FakeMessaging();
    let calls = 0;
    const real = flaky.sendMessage.bind(flaky);
    flaky.sendMessage = async (m) => {
      if (++calls === 2) throw new Error('transient network failure on chunk 2'); // once
      return real(m);
    };
    const app2 = boot(t.url, clock2, flaky, 'w2');
    for (let i = 1; i <= 50; i++) await app2.tasks.create(app2.db, o.ownerId, { title: LONG(i) });
    const send = (text: string, id: string) =>
      app2.intake.handle({
        accountId: o.accountId,
        updateKey: `msg:${id}`,
        providerMessageId: id,
        senderTelegramId: o.telegramUserId,
        chat: { type: 'private', id: o.telegramUserId },
        receivedAt: new Date(clock2.now()),
        text,
      });
    await send('my tasks', 'l1');
    await app2.tick(); // chunk 2 fails once
    clock2.advanceMs(5 * 60_000);
    await app2.tick(); // outbox retry resends with the same per-chunk keys
    const msgs = flaky.sent.map((m) => m.text);
    expect(msgs.length).toBeGreaterThan(1);
    for (const m of msgs) expect(m.length).toBeLessThanOrEqual(4096);
    const body = msgs.map((m) => m.replace(/^\(\d+\/\d+\)\n/, '')).join('\n');
    for (let i = 1; i <= 50; i++) expect(body.split('\n').filter((l) => l.startsWith(`${i}. `)).length).toBe(1); // each item exactly once
    expect(new Set(flaky.sent.map((m) => m.idempotencyKey)).size).toBe(flaky.sent.length); // no duplicate chunk keys
    // The numbers the owner sees still resolve against the snapshot of the full list.
    await send('done 37', 'l2');
    await app2.tick();
    const done = await t.db.query(`SELECT count(*)::int n FROM tasks WHERE status='done'`);
    expect(done.rows[0].n).toBe(1);
    await app2.close();
  });
  it('a permanent provider rejection is dead-lettered at once; a transient one is retried', async () => {
    const { FakeMessaging } = await import('../../apps/assistant/src/testing/fakes.js');
    const { PermanentDeliveryError } = await import('../../apps/assistant/src/modules/messaging/delivery-errors.js');
    const m = new FakeMessaging();
    m.sendMessage = async () => {
      throw new PermanentDeliveryError('USER_IS_BLOCKED');
    };
    const app2 = boot(t.url, new FakeClock(new Date('2026-10-15T06:00:00Z')), m, 'w3');
    await app2.reminders.create(o.ownerId, { title: 'x', localDateTime: '2026-10-16T09:00' });
    await app2.tick();
    const row = (await t.db.query(`SELECT delivery_state, attempts FROM outbox ORDER BY created_at LIMIT 1`)).rows[0];
    expect(row).toEqual({ delivery_state: 'dead', attempts: 1 });
    await app2.close();
  });
});

describe('F18 — configuration describes what actually runs', () => {
  it('CALLS_ENABLED=false denies dialing even when every evidence gate passes, and the capability report says so', async () => {
    const { FakeCallAdapter } = await import('../../apps/assistant/src/testing/fakes.js');
    const { ensureDailyBudget } = await import('../../apps/assistant/src/modules/operations/operations.service.js');
    const adapter = new FakeCallAdapter();
    const app2 = boot(t.url, clock, undefined, 'w4', {
      callAdapter: adapter,
      callsEnabled: false,
      deriveCapabilities: () => ({
        privateOutbound: true,
        privateInbound: false,
        pcmSend: true,
        pcmReceive: true,
        evidenceArtifact: 'TEST-ONLY',
        buildFingerprint: 'test',
        productionCallingAllowed: true,
        thirdPartyConsentMechanismProven: true,
        reasons: [],
      }),
    });
    await app2.operations.setKillSwitch(o.ownerId, false, 'test');
    await ensureDailyBudget(t.db, o.ownerId, '2026-10-15', 5_000_000);
    const c = await app2.contacts.create(
      t.db,
      o.ownerId,
      { telegramUserId: '555000111', displayName: 'J', verificationSource: 'owner_confirmed_numeric_id' },
      clock.now(),
    );
    await app2.contacts.grant(
      t.db,
      o.ownerId,
      c.id,
      { allowCall: true, topicScopes: ['x'], allowedHours: null, expiresAt: new Date('2026-12-01T00:00:00Z') },
      clock.now(),
    );
    const req = await app2.authorizations.createCallRequest(
      o.ownerId,
      {
        callRequestId: crypto.randomUUID(),
        ownerId: o.ownerId,
        recipientTelegramId: '555000111',
        topic: 'x',
        purpose: 'A purpose long enough',
        questions: [],
        allowedContext: [],
        forbiddenCommitments: [],
        language: 'en',
        maxDurationSeconds: 300,
        expiresAt: '2026-12-01T00:00:00.000Z',
      },
      { ownerExplicitCommand: true },
    );
    expect(await app2.orchestrator.dial(o.ownerId, req.callRequestId)).toMatchObject({ status: 'rejected', reason: 'calls_disabled' });
    expect(adapter.dials).toHaveLength(0);
    const srv2 = await buildServer({
      app: app2,
      log: createLogger('silent'),
      adminTokens: [TOKEN],
      runtime: {
        messagingAdapter: 'fake',
        interpreterAdapter: 'rules',
        callAdapter: 'fake',
        callsEnabled: false,
        evidencePath: null,
        buildFingerprint: 'x'.repeat(64),
        transcription: false,
      },
    });
    const cap = (await srv2.inject({ method: 'GET', url: '/v1/capabilities', headers: { authorization: `Bearer ${TOKEN}` } })).json().data;
    expect(cap.calling.available).toBe(false);
    expect(cap.calling.callsEnabled).toBe(false);
    await srv2.close();
    await app2.close();
  });
  it('TEXT_AI_ADAPTER=disabled performs no intent mutations and the capability report names the instantiated interpreter', async () => {
    const app2 = boot(t.url, clock, undefined, 'w5', { textAiDisabled: true });
    const r = await app2.intake.handle({
      accountId: o.accountId,
      updateKey: 'msg:dis-1',
      providerMessageId: '1',
      senderTelegramId: o.telegramUserId,
      chat: { type: 'private', id: o.telegramUserId },
      receivedAt: new Date(clock.now()),
      text: 'add task steal the cookies',
    });
    expect(r).toEqual({ status: 'handled', intent: 'unknown' });
    expect((await t.db.query('SELECT count(*)::int n FROM tasks')).rows[0].n).toBe(0);
    expect(app2.interpreterAdapter).toBe('disabled');
    await app2.close();
  });
  it('a configured owner that does not match the database aborts startup checks', async () => {
    const { verifyConfiguredOwner } = await import('../../apps/assistant/src/bootstrap/owner-check.js');
    expect(verifyConfiguredOwner({ production: true, configured: '42', owners: [{ telegram_user_id: '42' }] })).toBeNull();
    expect(verifyConfiguredOwner({ production: true, configured: '42', owners: [{ telegram_user_id: '43' }] })).toMatch(/does not match/);
    expect(verifyConfiguredOwner({ production: true, configured: '42', owners: [] })).toMatch(/not bootstrapped/);
    expect(verifyConfiguredOwner({ production: true, configured: '42', owners: [{ telegram_user_id: '42' }, { telegram_user_id: '43' }] })).toMatch(
      /exactly one/,
    );
    expect(verifyConfiguredOwner({ production: false, configured: undefined, owners: [] })).toBeNull(); // dev: nothing configured yet
    expect(verifyConfiguredOwner({ production: false, configured: '42', owners: [{ telegram_user_id: '43' }] })).toMatch(/does not match/);
  });
  it('invalid quiet-hours and timezone configuration fail clearly at the service boundary', async () => {
    const { inQuietHours } = await import('../../apps/assistant/src/modules/scheduling/quiet-hours.js');
    const now = new Date('2026-10-15T06:00:00Z');
    expect(() => inQuietHours(now, 'Asia/Samarkand', { enabled: true, start: '25:00', end: '08:00' })).toThrow(/quiet hours/i);
    expect(() => inQuietHours(now, 'Asia/Samarkand', { enabled: true, start: '22:00', end: '8' })).toThrow(/quiet hours/i);
    expect(() => inQuietHours(now, 'Mars/Olympus', { enabled: true, start: '22:00', end: '08:00' })).toThrow(/timezone/i);
    expect(inQuietHours(now, 'Asia/Samarkand', { enabled: false, start: 'junk', end: 'junk' })).toBe(false); // disabled windows are not parsed
    await expect(app.reminders.create(o.ownerId, { title: 'x', localDateTime: '2026-10-16T09:00', timezone: 'Mars/Olympus' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
});
