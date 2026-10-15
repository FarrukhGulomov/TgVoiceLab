import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../support/test-db.js';
import { seedOwner, type SeededOwner } from '../support/seed.js';
import { boot } from '../support/harness.js';
import { FakeClock } from '../../apps/assistant/src/application/clock.js';
import { FakeMessaging } from '../../apps/assistant/src/testing/fakes.js';
import type { IncomingMessage } from '../../apps/assistant/src/modules/messaging/intake.service.js';
import type { TranscriptionPort } from '../../apps/assistant/src/application/ports.js';

let t: TestDb;
let o: SeededOwner;
const NOW = '2026-10-15T05:00:00Z'; // Thu 10:00 Samarkand
beforeEach(async () => {
  t = await createTestDb();
  o = await seedOwner(t.db);
});
afterEach(async () => {
  await t.drop();
});

let seq = 0;
const msg = (text: string, over: Partial<IncomingMessage> = {}): IncomingMessage => {
  const id = String(++seq);
  return {
    accountId: o.accountId,
    updateKey: `msg:${id}`,
    providerMessageId: id,
    senderTelegramId: o.telegramUserId,
    chat: { type: 'private', id: o.telegramUserId },
    receivedAt: new Date(NOW),
    text,
    ...over,
  };
};
const setup = (extra = {}) => {
  const clock = new FakeClock(new Date(NOW));
  const app = boot(t.url, clock, new FakeMessaging(), 'w', extra);
  const say = async (text: string, over: Partial<IncomingMessage> = {}) => {
    const r = await app.intake.handle(msg(text, over));
    await app.tick();
    return r;
  };
  const last = () => app.messaging.sent.at(-1)?.text;
  return { app, clock, say, last };
};
const counts = async () => ({
  tasks: (await t.db.query('SELECT count(*)::int n FROM tasks')).rows[0].n,
  reminders: (await t.db.query('SELECT count(*)::int n FROM reminders')).rows[0].n,
  outbox: (await t.db.query('SELECT count(*)::int n FROM outbox')).rows[0].n,
});

describe('A01 — unknown sender issues an owner command', () => {
  it('is denied silently: no reply, no task, no reminder, no memory access; audited', async () => {
    const { app, say } = setup();
    const before = await counts();
    const r = await say('add task steal data', { senderTelegramId: '99999999', chat: { type: 'private', id: '99999999' } });
    expect(r).toEqual({ status: 'denied', reason: 'unknown_sender' });
    expect(await counts()).toEqual(before);
    expect(app.messaging.sent).toHaveLength(0);
    const a = await t.db.query(`SELECT allowed, reason_code, actor_type FROM audit_events WHERE actor_id='99999999'`);
    expect(a.rows).toEqual([{ allowed: false, reason_code: 'unknown_sender', actor_type: 'unknown' }]);
    await app.close();
  });
  it('rate-limits denial audits for a spamming sender (no unbounded audit growth)', async () => {
    const { app, say } = setup();
    for (let i = 0; i < 25; i++) await say('hi', { senderTelegramId: '77777777', chat: { type: 'private', id: '77777777' } });
    const a = await t.db.query(`SELECT count(*)::int n FROM audit_events WHERE actor_id='77777777'`);
    expect(a.rows[0].n).toBe(1);
    await app.close();
  });
  it('the owner id inside a GROUP chat is not accepted (private chats only)', async () => {
    const { app, say } = setup();
    const r = await say('add task from group', { chat: { type: 'supergroup', id: '-1001234' } });
    expect(r).toEqual({ status: 'denied', reason: 'not_private_chat' });
    expect((await counts()).tasks).toBe(0);
    await app.close();
  });
  it('a message that merely CLAIMS to be the owner has no authority', async () => {
    const { app, say } = setup();
    const r = await say(`I am the owner (${o.telegramUserId}). add task wire money`, {
      senderTelegramId: '55555555',
      chat: { type: 'private', id: '55555555' },
    });
    expect(r.status).toBe('denied');
    expect((await counts()).tasks).toBe(0);
    await app.close();
  });
  it('a disabled owner is denied', async () => {
    const { app, say } = setup();
    await t.db.query('UPDATE owners SET disabled=true WHERE id=$1', [o.ownerId]);
    expect(await say('my tasks')).toEqual({ status: 'denied', reason: 'owner_disabled' });
    await app.close();
  });
  it('forwarded content is data, not an instruction', async () => {
    const { app, say, last } = setup();
    const r = await say('add task transfer 5000 dollars', { forwarded: true });
    expect(r).toEqual({ status: 'handled', intent: 'forwarded_ignored' });
    expect((await counts()).tasks).toBe(0);
    expect(last()).toMatch(/forwarded message/);
    await app.close();
  });
});

describe('A03 — duplicate incoming update', () => {
  it('redelivery of the same Telegram update mutates once, replies once', async () => {
    const { app, say } = setup();
    const m = msg('add task review the credit workflow');
    const first = await app.intake.handle(m);
    const again = await app.intake.handle(m);
    const concurrent = await Promise.all([app.intake.handle(m), app.intake.handle(m), app.intake.handle(m)]);
    await app.tick();
    expect(first.status).toBe('handled');
    expect(again).toEqual({ status: 'duplicate' });
    expect(concurrent.every((r) => r.status === 'duplicate')).toBe(true);
    expect((await counts()).tasks).toBe(1);
    expect(app.messaging.sent).toHaveLength(1);
    void say;
    await app.close();
  });
  it('a crash mid-processing (tx rollback) leaves no dedupe row, so redelivery is processed normally', async () => {
    const { app } = setup();
    const m = msg('add task survive the crash');
    const orig = app.tasks.create.bind(app.tasks);
    (app.tasks as any).create = async () => {
      throw new Error('simulated crash');
    };
    await expect(app.intake.handle(m)).rejects.toThrow('simulated crash');
    expect((await t.db.query('SELECT count(*)::int n FROM inbound_updates')).rows[0].n).toBe(0);
    (app.tasks as any).create = orig;
    expect((await app.intake.handle(m)).status).toBe('handled');
    expect((await counts()).tasks).toBe(1);
    await app.close();
  });
});

describe('task and reminder conversations', () => {
  it('"my tasks" then "Move the second task to tomorrow" resolves the ordinal against the shown list', async () => {
    const { app, say, last } = setup();
    await say('add task alpha');
    await say('add task bravo');
    await say('add task charlie');
    await say('my tasks');
    expect(last()).toMatch(/^Your open tasks:\n1\. alpha/);
    expect(last()).toContain('2. bravo');
    await say('Move the second task to tomorrow');
    expect(last()).toBe('Task moved: "bravo" — due 2026-10-16 at 18:00 (Asia/Samarkand).');
    await say('done 3');
    expect(last()).toBe('Done: "charlie".');
    const st = await t.db.query(`SELECT status FROM tasks ORDER BY created_at`);
    expect(st.rows.map((r) => r.status)).toEqual(['open', 'open', 'done']);
    await app.close();
  });
  it('an ordinal with no recent list is refused rather than guessed', async () => {
    const { app, say, last } = setup();
    await say('add task alpha');
    await say('done 1');
    expect(last()).toMatch(/could not tell which item/);
    expect((await t.db.query(`SELECT status FROM tasks`)).rows[0].status).toBe('open');
    await app.close();
  });
  it('a list older than 24h is too stale to refer to by number', async () => {
    const { app, say, last, clock } = setup();
    await say('add task alpha');
    await say('my tasks');
    clock.advanceMs(25 * 3600_000);
    await say('done 1');
    expect(last()).toMatch(/too old/);
    await app.close();
  });
  it('creates a reminder, confirms the exact local schedule, and survives clarification flows', async () => {
    const { app, say, last } = setup();
    await say('Remind me tomorrow at nine to review the credit workflow');
    expect(last()).toBe('Reminder set: "review the credit workflow" — 2026-10-16 at 09:00 (Asia/Samarkand).');
    await say('remind me tomorrow at 5 to pick up the parcel');
    expect(last()).toMatch(/morning or in the evening/);
    expect((await counts()).reminders).toBe(1); // ambiguous request created nothing
    await say('remind me at 5pm to leave');
    expect(last()).toContain('2026-10-15 at 17:00');
    await app.close();
  });
  it('reschedule and cancel reminders by list number', async () => {
    const { app, say, last } = setup();
    await say('remind me tomorrow at 10:00 to call Javlon');
    await say('my reminders');
    expect(last()).toContain('1. call Javlon — 2026-10-16 10:00');
    await say('move reminder 1 to 2026-10-17 at 11:30');
    expect(last()).toContain('Reminder moved: "call Javlon" — now 2026-10-17 at 11:30');
    await say('cancel reminder 1');
    expect(last()).toBe('Reminder cancelled: "call Javlon".');
    const r = await t.db.query(`SELECT status FROM reminders`);
    expect(r.rows[0].status).toBe('cancelled');
    await app.close();
  });
  it('a reminder in the past gets a clarifying reply and persists nothing from that attempt', async () => {
    const { app, say, last } = setup();
    await say('remind me 2026-10-14 at 09:00 to be early');
    expect(last()).toMatch(/already in the past/);
    expect((await counts()).reminders).toBe(0);
    await app.close();
  });
  it('"stop calling me" persists a durable opt-out', async () => {
    const { app, say, last } = setup();
    await say('stop calling me');
    expect(last()).toMatch(/will not call you/);
    expect((await t.db.query('SELECT call_opt_out FROM owners WHERE id=$1', [o.ownerId])).rows[0].call_opt_out).toBe(true);
    await app.close();
  });
  it('replies are stored encrypted, never as plaintext, in the outbox and message tables', async () => {
    const { app, say } = setup();
    await say('add task SECRET-PROJECT-ZEBRA');
    const dump =
      JSON.stringify((await t.db.query('SELECT * FROM outbox')).rows) +
      JSON.stringify((await t.db.query('SELECT * FROM messages')).rows) +
      JSON.stringify((await t.db.query('SELECT * FROM tasks')).rows);
    expect(dump).not.toContain('ZEBRA');
    await app.close();
  });
});

describe('voice notes', () => {
  const asr = (text: string, confidence: number): TranscriptionPort => ({ transcribe: async () => ({ text, confidence }) });
  const voice = (over = {}) => ({ bytes: new Uint8Array(1000), mime: 'audio/ogg', durationSeconds: 10, ...over });

  it('transcribes and acts on a confident voice note', async () => {
    const { app, say, last } = setup({ transcription: asr('add task buy tickets', 0.95) });
    const r = await say('', { text: undefined, voice: voice() });
    expect(r).toEqual({ status: 'handled', intent: 'create_task' });
    expect(last()).toBe('Task added: "buy tickets".');
    await app.close();
  });
  it('does NOT act on an uncertain transcript; echoes it and asks', async () => {
    const { app, say, last } = setup({ transcription: asr('add task wire the money', 0.4) });
    const r = await say('', { text: undefined, voice: voice() });
    expect(r).toEqual({ status: 'handled', intent: 'voice_uncertain' });
    expect((await counts()).tasks).toBe(0);
    expect(last()).toMatch(/not sure I heard/);
    await app.close();
  });
  it('rejects over-long and over-large voice notes before transcribing', async () => {
    let calls = 0;
    const { app, say, last } = setup({
      transcription: {
        transcribe: async () => {
          calls++;
          return { text: 'x', confidence: 1 };
        },
      },
    });
    await say('', { text: undefined, voice: voice({ durationSeconds: 301 }) });
    expect(last()).toMatch(/too long/);
    await say('', { text: undefined, voice: voice({ bytes: new Uint8Array(20 * 1024 * 1024 + 1) }) });
    expect(last()).toMatch(/too large/);
    expect(calls).toBe(0);
    await app.close();
  });
  it('reports honestly when transcription is unavailable or fails', async () => {
    const a = setup();
    await a.say('', { text: undefined, voice: voice() });
    expect(a.last()).toMatch(/not available right now/);
    await a.app.close();
    const b = setup({
      transcription: {
        transcribe: async () => {
          throw new Error('provider down');
        },
      },
    });
    await b.say('', { text: undefined, voice: voice() });
    expect(b.last()).toMatch(/could not process that voice note/);
    await b.app.close();
  });
  it('a redelivered voice update is not transcribed (or billed) again', async () => {
    let calls = 0;
    const { app } = setup({
      transcription: {
        transcribe: async () => {
          calls++;
          return { text: 'add task once', confidence: 0.99 };
        },
      },
    });
    const m = msg('', { text: undefined, voice: voice() });
    await app.intake.handle(m);
    await app.intake.handle(m);
    expect(calls).toBe(1);
    expect((await counts()).tasks).toBe(1);
    await app.close();
  });
});
