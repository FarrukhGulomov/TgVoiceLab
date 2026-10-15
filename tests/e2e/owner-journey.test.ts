import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../support/test-db.js';
import { boot } from '../support/harness.js';
import { FakeClock } from '../../apps/assistant/src/application/clock.js';
import { FakeMessaging } from '../../apps/assistant/src/testing/fakes.js';
import { bootstrapOwner, bootstrapPhrase } from '../../apps/assistant/src/modules/identity/identity.js';
import { buildServer } from '../../apps/assistant/src/http/server.js';
import { createLogger } from '../../apps/assistant/src/infrastructure/observability/logger.js';

/**
 * End-to-end journey of the working text/task MVP (deterministic fakes for Telegram only; real PostgreSQL, real services,
 * real HTTP server, real job/outbox workers, real process "restart" by rebuilding everything from the database).
 * Fakes are labeled and prove NOTHING about live Telegram.
 */
const OWNER = '1234567';
const ASSISTANT = '7654321';
let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.drop();
});

describe('owner bootstrap is explicit and safe', () => {
  const args = (over = {}) => ({
    ownerTelegramId: OWNER,
    assistantTelegramId: ASSISTANT,
    sessionSecretRef: 'file:/run/secrets/telegram.session',
    timezone: 'Asia/Samarkand',
    confirmation: bootstrapPhrase(OWNER, ASSISTANT),
    ...over,
  });
  it('requires the exact confirmation echoing BOTH ids, numeric ids only, owner != assistant, a secret REFERENCE', async () => {
    const app = boot(t.url, new FakeClock(new Date()));
    await expect(bootstrapOwner(app.db, args({ confirmation: 'yes' }))).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(bootstrapOwner(app.db, args({ confirmation: bootstrapPhrase(OWNER, '999') }))).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(bootstrapOwner(app.db, args({ ownerTelegramId: '@javlon', confirmation: 'x' }))).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(bootstrapOwner(app.db, args({ assistantTelegramId: OWNER, confirmation: bootstrapPhrase(OWNER, OWNER) }))).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(bootstrapOwner(app.db, args({ sessionSecretRef: 'literal-secret-value' }))).rejects.toMatchObject({ code: 'invalid_input' });
    expect((await app.db.query('SELECT count(*)::int n FROM owners')).rows[0].n).toBe(0);
    await app.close();
  });
  it('is idempotent for the same ids, refuses a second/different owner, and starts with calling switched off', async () => {
    const app = boot(t.url, new FakeClock(new Date()));
    const first = await bootstrapOwner(app.db, args());
    expect(first.created).toBe(true);
    expect((await bootstrapOwner(app.db, args())).created).toBe(false);
    await expect(bootstrapOwner(app.db, args({ ownerTelegramId: '555', confirmation: bootstrapPhrase('555', ASSISTANT) }))).rejects.toMatchObject({
      message: expect.stringMatching(/exactly one owner/),
    });
    expect((await app.db.query('SELECT calling_kill_switch FROM operation_settings')).rows[0].calling_kill_switch).toBe(true);
    expect((await app.db.query('SELECT status FROM telegram_accounts')).rows[0].status).toBe('unprovisioned');
    await app.close();
  });
  it('the first stranger to message the account is NOT enrolled as owner', async () => {
    const app = boot(t.url, new FakeClock(new Date()));
    const { accountId } = await bootstrapOwner(app.db, args());
    const r = await app.intake.handle({
      accountId,
      updateKey: 'u1',
      providerMessageId: '1',
      senderTelegramId: '31337',
      chat: { type: 'private', id: '31337' },
      receivedAt: new Date(),
      text: 'hello, I am the owner now',
    });
    expect(r).toEqual({ status: 'denied', reason: 'unknown_sender' });
    expect((await app.db.query('SELECT telegram_user_id FROM owners')).rows.map((x) => x.telegram_user_id)).toEqual([OWNER]);
    await app.close();
  });
});

describe('full text-MVP journey across a restart', () => {
  it('bootstrap → chat → reminder → restart → fire; calling stays honestly unavailable throughout', async () => {
    const clock = new FakeClock(new Date('2026-10-15T05:00:00Z')); // Thu 10:00 Samarkand
    const msgs = new FakeMessaging();
    let app = boot(t.url, clock, msgs, 'w1');
    const { accountId } = await bootstrapOwner(app.db, {
      ownerTelegramId: OWNER,
      assistantTelegramId: ASSISTANT,
      sessionSecretRef: 'env:X',
      timezone: 'Asia/Samarkand',
      locale: 'en',
      confirmation: bootstrapPhrase(OWNER, ASSISTANT),
    });
    let n = 0;
    const say = async (text: string, from = OWNER) => {
      const id = String(++n);
      const r = await app.intake.handle({
        accountId,
        updateKey: `m${id}`,
        providerMessageId: id,
        senderTelegramId: from,
        chat: { type: 'private', id: from },
        receivedAt: clock.now(),
        text,
      });
      await app.tick();
      return r;
    };
    const last = () => msgs.sent.at(-1)?.text;

    expect((await say('hello', '99')).status).toBe('denied'); // A01
    expect(msgs.sent).toHaveLength(0);

    await say('add task Review the credit workflow');
    await say('Remind me tomorrow at nine to review the credit workflow');
    expect(last()).toBe('Reminder set: "review the credit workflow" — 2026-10-16 at 09:00 (Asia/Samarkand).');
    await say('my tasks');
    expect(last()).toContain('1. Review the credit workflow');

    // Same HTTP surface the operator uses, against the same database.
    const srv = await buildServer({
      app,
      log: createLogger('silent'),
      adminTokens: ['A'.repeat(40)],
      runtime: {
        messagingAdapter: 'fake',
        interpreterAdapter: 'rules',
        callAdapter: 'disabled',
        evidencePath: null,
        buildFingerprint: 'x'.repeat(64),
        transcription: false,
      },
    });
    const caps = (await srv.inject({ method: 'GET', url: '/v1/capabilities', headers: { authorization: `Bearer ${'A'.repeat(40)}` } })).json().data;
    expect(caps.mode).toBe('degraded_text_only');
    expect(caps.calling.available).toBe(false);
    await srv.close();

    // Crash/restart: new process, empty memory, same database.
    await app.close();
    app = boot(t.url, clock, msgs, 'w2');
    await app.recoverCalls();
    clock.set('2026-10-16T04:00:10Z'); // 09:00:10 local
    await app.tick();
    expect(last()).toBe('⏰ Reminder: review the credit workflow');
    const fires = msgs.sent.filter((m) => m.text.startsWith('⏰'));
    expect(fires).toHaveLength(1);
    await app.tick();
    await app.tick();
    expect(msgs.sent.filter((m) => m.text.startsWith('⏰'))).toHaveLength(1);

    // Owner asks for a call reminder -> clearly labeled degraded delivery, never silence.
    await say('remind me at 15:00 to call Javlon');
    const calls = await app.db.query(`SELECT count(*)::int n FROM calls`);
    expect(calls.rows[0].n).toBe(0);
    await app.close();
  });
});
