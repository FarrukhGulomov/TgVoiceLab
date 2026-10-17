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

describe('F16 — a clarifying question keeps its state for the next reply', () => {
  const PHRASE = 'KVARTS-9921';
  const say = (text: string, id: string) =>
    app.intake.handle({
      accountId: o.accountId,
      updateKey: `msg:cl-${id}`,
      providerMessageId: id,
      senderTelegramId: o.telegramUserId,
      chat: { type: 'private', id: o.telegramUserId },
      receivedAt: new Date(clock.now()),
      text,
    });
  const reminders = async () =>
    (await t.db.query(`SELECT local_wall_clock::text AS w FROM reminders WHERE status='active' ORDER BY created_at`)).rows.map((r) => r.w as string);
  it('"remind me tomorrow to X" -> asks the time -> "17:00" creates exactly ONE correct reminder; the draft is then gone', async () => {
    expect(await say(`remind me tomorrow to review ${PHRASE}`, '1')).toEqual({ status: 'handled', intent: 'clarify' });
    expect(await reminders()).toEqual([]);
    expect(await say('17:00', '2')).toEqual({ status: 'handled', intent: 'create_reminder' });
    expect(await reminders()).toEqual(['2026-10-16 17:00:00']);
    await app.tick();
    expect(app.messaging.sent.at(-1)?.text).toMatch(/2026-10-16 at 17:00/);
    expect(await say('17:00', '3')).toEqual({ status: 'handled', intent: 'unknown' }); // consumed: a stray time is not a second reminder
    expect(await reminders()).toHaveLength(1);
  });
  it('Uzbek: "Ertaga uchrashuvni eslat" -> asks -> "17:00"', async () => {
    expect(await say('Ertaga uchrashuvni eslat', '1')).toEqual({ status: 'handled', intent: 'clarify' });
    expect(await say('17:00', '2')).toEqual({ status: 'handled', intent: 'create_reminder' });
    expect(await reminders()).toEqual(['2026-10-16 17:00:00']);
  });
  it('an ambiguous hour is resolved by "evening"; "5 pm" also works', async () => {
    await say('remind me tomorrow at 5 to pick up the parcel', '1');
    expect(await say('evening', '2')).toEqual({ status: 'handled', intent: 'create_reminder' });
    expect(await reminders()).toEqual(['2026-10-16 17:00:00']);
    await say('remind me tomorrow to call Javlon', '3');
    expect(await say('5 pm', '4')).toEqual({ status: 'handled', intent: 'create_reminder' });
    expect(await reminders()).toHaveLength(2);
  });
  it('an expired draft and an unrelated reply cause no mutation', async () => {
    await say('remind me tomorrow to call Javlon', '1');
    expect(await say("what's the weather like", '2')).toEqual({ status: 'handled', intent: 'unknown' }); // unrelated: nothing happens, draft still waits
    clock.advanceMs(11 * 60_000);
    expect(await say('17:00', '3')).toEqual({ status: 'handled', intent: 'unknown' }); // expired
    expect(await reminders()).toEqual([]);
  });
  it('a new explicit command replaces the draft, and an old stray time never revives it', async () => {
    await say('remind me tomorrow to call Javlon', '1');
    await say('add task buy tickets', '2');
    expect(await say('17:00', '3')).toEqual({ status: 'handled', intent: 'unknown' });
    expect(await reminders()).toEqual([]);
  });
  it('keeps one draft per owner (a newer question replaces the older) and stores it sealed', async () => {
    await say(`remind me tomorrow to first ${PHRASE}`, '1');
    await say('remind me tomorrow to second thing', '2');
    expect((await t.db.query('SELECT count(*)::int n FROM conversation_drafts')).rows[0].n).toBe(1);
    const raw = (await t.db.query<{ r: string }>('SELECT x::text AS r FROM conversation_drafts x')).rows[0]!.r;
    expect(raw).not.toContain('second thing');
    expect(raw).not.toContain(PHRASE);
    await say('09:30', '3');
    expect(await reminders()).toEqual(['2026-10-16 09:30:00']);
    await app.tick();
    expect(app.messaging.sent.map((m) => m.text).join('\n')).toContain('second thing');
  });
});

describe('F15 — restart recovery pages back to a durable watermark and retries without a manual restart', () => {
  const DAY = 86_400_000;
  type Msg = { id: number; out: boolean; dateMs: number; text: string };
  const history = (n: number, now: number, opts: { oldIds?: number[] } = {}): Msg[] => {
    // ids 1..2n: odd = incoming owner command, even = our own outbound reply interleaved in the history
    const msgs: Msg[] = [];
    for (let id = 1; id <= 2 * n; id++)
      msgs.push({ id, out: id % 2 === 0, dateMs: opts.oldIds?.includes(id) ? now - 3 * DAY : now - (2 * n - id) * 1000, text: `add task recovered-${id}` });
    return msgs;
  };
  const source = (msgs: Msg[]) => {
    const calls: number[] = [];
    return {
      calls,
      fetchPage: async (offsetId: number, limit: number) => {
        calls.push(offsetId);
        return msgs
          .filter((m) => offsetId === 0 || m.id < offsetId)
          .sort((a, b) => b.id - a.id)
          .slice(0, limit);
      },
    };
  };
  const mk = async (failAtId?: number) => {
    const { RecoveryRunner, DbWatermarkStore } = await import('../../apps/assistant/src/infrastructure/telegram/recovery.js');
    let failOnce = failAtId;
    const handled: number[] = [];
    const runner = (src: ReturnType<typeof source>, extra: object = {}) =>
      new RecoveryRunner({
        accountId: o.accountId,
        chatId: o.telegramUserId,
        source: src,
        store: new DbWatermarkStore(app.db, () => clock.now()),
        clock: () => clock.now(),
        windowMs: DAY,
        pageSize: 100,
        handle: async (m: Msg) => {
          if (failOnce === m.id) {
            failOnce = undefined;
            throw new Error('transient intake failure');
          }
          handled.push(m.id);
          await app.intake.handle({
            accountId: o.accountId,
            updateKey: `msg:${o.telegramUserId}:${m.id}`,
            providerMessageId: String(m.id),
            senderTelegramId: o.telegramUserId,
            chat: { type: 'private', id: o.telegramUserId },
            receivedAt: new Date(m.dateMs),
            text: m.text,
          });
        },
        ...extra,
      });
    return { runner, handled };
  };
  const taskCount = async () => (await t.db.query('SELECT count(*)::int n FROM tasks')).rows[0].n as number;

  it('recovers 120 owner messages from 240 history entries (outbound interleaved) across several pages, each exactly once', async () => {
    const now = clock.now().getTime();
    const src = source(history(120, now));
    const { runner } = await mk();
    const r = await runner(src).runOnce();
    expect(r).toMatchObject({ complete: true });
    expect(await taskCount()).toBe(120);
    expect(src.calls.length).toBeGreaterThanOrEqual(3); // 240 entries / 100 per page
    // A second pass finds the watermark and does no new work.
    const src2 = source(history(120, now));
    const r2 = await runner(src2).runOnce();
    expect(r2).toMatchObject({ complete: true });
    expect(await taskCount()).toBe(120);
    expect(src2.calls).toEqual([0]); // one page: the first message is already behind the watermark
  });
  it('never executes instructions older than the age window, but still recovers newer ones', async () => {
    const now = clock.now().getTime();
    const src = source(history(10, now, { oldIds: [1, 3, 5] }));
    const { runner } = await mk();
    await runner(src).runOnce();
    expect(await taskCount()).toBe(7);
  });
  it('a transient failure marks recovery incomplete, keeps the watermark, and the NEXT pass resumes without a restart or duplicates', async () => {
    const now = clock.now().getTime();
    const msgs = history(60, now);
    const { runner } = await mk(57); // odd ids are incoming: 57 fails once
    const rr = runner(source(msgs));
    const first = await rr.runOnce();
    expect(first.complete).toBe(false);
    expect(rr.status().recovery).toBe('incomplete');
    expect((await t.db.query('SELECT last_message_id::int AS w FROM recovery_watermarks')).rows[0].w).toBe(56); // everything below 57 is done
    const tasksAfterFailure = await taskCount();
    expect(tasksAfterFailure).toBeLessThan(30);
    const second = await rr.runOnce();
    expect(second.complete).toBe(true);
    expect(rr.status().recovery).toBe('complete');
    expect(await taskCount()).toBe(60);
    expect((await t.db.query('SELECT last_message_id::int AS w FROM recovery_watermarks')).rows[0].w).toBe(120);
  });
  it('reports degraded (not silently complete) when the page cap is hit before reaching the watermark', async () => {
    const now = clock.now().getTime();
    const { runner } = await mk();
    const rr = runner(source(history(300, now)), { maxPages: 2 });
    const r = await rr.runOnce();
    expect(r.complete).toBe(false);
    expect(r.reason).toBe('page_cap');
    expect(rr.status().recovery).toBe('incomplete');
  });
  it('the readiness endpoint exposes the recovery status when the messaging adapter provides one', async () => {
    const srv3 = await buildServer({
      app,
      log: createLogger('silent'),
      adminTokens: [TOKEN],
      runtime: {
        messagingAdapter: 'telegram',
        interpreterAdapter: 'rules',
        callAdapter: 'disabled',
        callsEnabled: false,
        evidencePath: null,
        buildFingerprint: 'x'.repeat(64),
        transcription: false,
        messagingStatus: () => ({ recovery: 'incomplete', lastError: 'transient intake failure' }),
      },
    });
    const body = (await srv3.inject({ method: 'GET', url: '/health/ready', headers: { authorization: `Bearer ${TOKEN}` } })).json().data;
    expect(body.messaging).toEqual({ recovery: 'incomplete', lastError: 'transient intake failure' });
    await srv3.close();
  });
});
