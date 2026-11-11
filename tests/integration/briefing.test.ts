import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../support/test-db.js';
import { seedOwner, type SeededOwner } from '../support/seed.js';
import { boot } from '../support/harness.js';
import { FakeClock } from '../../apps/assistant/src/application/clock.js';
import { FakeMessaging } from '../../apps/assistant/src/testing/fakes.js';
import type { IncomingMessage } from '../../apps/assistant/src/modules/messaging/intake.service.js';

let t: TestDb;
let o: SeededOwner;
// Owner timezone Asia/Samarkand (UTC+5). Thu 2026-10-15 10:00 local = 05:00Z.
const NOW = '2026-10-15T05:00:00Z';
beforeEach(async () => {
  t = await createTestDb();
  o = await seedOwner(t.db);
});
afterEach(async () => {
  await t.drop();
});

let seq = 0;
const setup = () => {
  const clock = new FakeClock(new Date(NOW));
  const app = boot(t.url, clock, new FakeMessaging(), 'w');
  const say = async (text: string) => {
    const id = String(++seq);
    const msg: IncomingMessage = {
      accountId: o.accountId,
      updateKey: `msg:b${id}`,
      providerMessageId: id,
      senderTelegramId: o.telegramUserId,
      chat: { type: 'private', id: o.telegramUserId },
      receivedAt: clock.now(),
      text,
    };
    await app.intake.handle(msg);
    await app.tick();
  };
  const texts = () => app.messaging.sent.map((m) => m.text);
  const last = () => app.messaging.sent.at(-1)?.text ?? '';
  return { app, clock, say, texts, last };
};
const local = (iso: string) => new Date(iso); // readability: pass UTC instants explicitly

describe('daily briefing', () => {
  it('is set from chat, confirmed with the exact local time, and delivered with overdue + due-today tasks that "done N" can refer to', async () => {
    const { app, clock, say, last } = setup();
    await app.tasks.create(app.db, o.ownerId, { title: 'Overdue report', dueAt: local('2026-10-14T05:00:00Z') });
    await app.tasks.create(app.db, o.ownerId, { title: 'Call the bank', dueAt: local('2026-10-16T10:00:00Z') }); // 15:00 local on the 16th
    await app.tasks.create(app.db, o.ownerId, { title: 'Next week thing', dueAt: local('2026-10-22T05:00:00Z') });
    await app.tasks.create(app.db, o.ownerId, { title: 'No due date' });

    await say('daily briefing at 08:00');
    expect(last()).toBe('Daily briefing set: every day at 08:00 (Asia/Samarkand).');

    clock.set('2026-10-16T03:00:05Z'); // 08:00:05 local on the 16th
    await app.tick();
    const text = last();
    expect(text).toContain('Briefing for 2026-10-16');
    expect(text).toContain('Overdue:\n1. Overdue report — 2026-10-14 10:00');
    expect(text).toContain('Due today:\n2. Call the bank — 15:00');
    expect(text).not.toContain('Next week thing');
    expect(text).not.toContain('No due date');

    // the owner refers to the numbering they just saw
    await say('done 2');
    expect(last()).toBe('Done: "Call the bank".');
    expect((await t.db.query(`SELECT count(*)::int n FROM tasks WHERE status='done'`)).rows[0].n).toBe(1);
    await app.close();
  });

  it('repeats every day (the next occurrence is scheduled in the same transaction) and an empty day says so', async () => {
    const { app, clock, say, texts } = setup();
    await say('daily briefing at 08:00');
    clock.set('2026-10-16T03:00:05Z');
    await app.tick();
    clock.set('2026-10-17T03:00:05Z');
    await app.tick();
    const briefs = texts().filter((x) => x.includes('Briefing for'));
    expect(briefs).toHaveLength(2);
    expect(briefs[1]).toContain('Briefing for 2026-10-17');
    expect(briefs[1]).toContain('Nothing overdue and nothing due today.');
    await app.close();
  });

  it('setting a new time replaces the old briefing: exactly one stays active, and only the new time fires', async () => {
    const { app, clock, say, texts } = setup();
    await say('daily briefing at 08:00');
    await say('brief me every day at 09:30');
    expect((await t.db.query(`SELECT count(*)::int n FROM reminders WHERE kind='briefing' AND status='active'`)).rows[0].n).toBe(1);
    clock.set('2026-10-16T03:00:05Z'); // 08:00 local: the old time must NOT fire
    await app.tick();
    expect(texts().some((x) => x.includes('Briefing for'))).toBe(false);
    clock.set('2026-10-16T04:30:05Z'); // 09:30 local
    await app.tick();
    expect(texts().filter((x) => x.includes('Briefing for'))).toHaveLength(1);
    await app.close();
  });

  it("is not listed among the owner's reminders", async () => {
    const { app, say, last } = setup();
    await say('daily briefing at 08:00');
    await say('my reminders');
    expect(last()).toBe('You have no active reminders.');
    await app.close();
  });

  it('can be cancelled; cancelling again says there is none; nothing fires afterwards', async () => {
    const { app, clock, say, last, texts } = setup();
    await say('daily briefing at 08:00');
    await say('cancel briefing');
    expect(last()).toBe('Daily briefing cancelled.');
    await say('stop briefing');
    expect(last()).toBe('You have no daily briefing set.');
    clock.set('2026-10-16T03:00:05Z');
    await app.tick();
    expect(texts().some((x) => x.includes('Briefing for'))).toBe(false);
    await app.close();
  });

  it('asks for the time when it is missing, and understands Uzbek', async () => {
    const { app, say, last } = setup();
    await say('daily briefing');
    expect(last()).toContain('What time should I send the daily briefing?');
    expect((await t.db.query(`SELECT count(*)::int n FROM reminders`)).rows[0].n).toBe(0);
    await say('har kuni soat 08:00 da brifing');
    expect((await t.db.query(`SELECT count(*)::int n FROM reminders WHERE kind='briefing' AND status='active'`)).rows[0].n).toBe(1);
    await app.close();
  });

  it("a briefing that could not be sent for hours is skipped silently, and tomorrow's is still scheduled", async () => {
    const { app, clock, say, texts } = setup();
    await say('daily briefing at 08:00');
    const before = texts().length;
    clock.set('2026-10-16T08:30:00Z'); // 13:30 local: 5.5 h late
    await app.tick();
    expect(texts()).toHaveLength(before); // no stale briefing
    const occ = await t.db.query(`SELECT state FROM reminder_occurrences ORDER BY scheduled_at`);
    expect(occ.rows.map((r) => r.state)).toEqual(['summarized_missed', 'scheduled']);
    await app.close();
  });
});
