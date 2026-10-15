import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../support/test-db.js';
import { seedOwner, type SeededOwner } from '../support/seed.js';
import { boot } from '../support/harness.js';
import { FakeClock } from '../../apps/assistant/src/application/clock.js';
import { FakeMessaging } from '../../apps/assistant/src/testing/fakes.js';
import { claimJobs } from '../../apps/assistant/src/modules/jobs/jobs.js';
import { fireReminderOccurrence } from '../../apps/assistant/src/modules/scheduling/reminder-jobs.js';

let t: TestDb;
let o: SeededOwner;
// One database per test: a worker tick processes every owner's due work, so shared state would cross-talk between tests.
beforeEach(async () => { t = await createTestDb(); o = await seedOwner(t.db); });
afterEach(async () => { await t.drop(); });

// Owner timezone is Asia/Samarkand (UTC+5). 2026-10-15 12:00 local = 07:00Z.
const START = '2026-10-15T07:00:00Z';
const sent = (m: FakeMessaging) => m.sent.map((x) => x.text);

describe('task -> restart -> reminder (A02, spec Phase 2 demo)', () => {
  it('a committed reminder survives a process restart and fires exactly once', async () => {
    const clock = new FakeClock(new Date(START));
    const msgs = new FakeMessaging();
    let app = boot(t.url, clock, msgs);

    const task = await app.tasks.create(app.db, o.ownerId, { title: 'Review the credit workflow' });
    const rem = await app.reminders.create(o.ownerId, { title: task.title, localDateTime: '2026-10-16T09:00', taskId: task.id });
    expect(rem.next).toMatchObject({ date: '2026-10-16', time: '09:00', tz: 'Asia/Samarkand' });
    expect(rem.nextOccurrenceAt).toBe('2026-10-16T04:00:00.000Z');

    // Confirmation goes out only after commit, via the outbox, with the exact interpreted schedule.
    await app.tick();
    expect(sent(msgs)).toEqual(['Reminder set: "Review the credit workflow" — 2026-10-16 at 09:00 (Asia/Samarkand).']);

    // "Restart": drop the pool and rebuild everything from the database alone.
    await app.close();
    clock.set('2026-10-16T03:59:00Z');
    app = boot(t.url, clock, msgs);
    await app.tick();
    expect(msgs.sent).toHaveLength(1); // not due yet

    clock.set('2026-10-16T04:00:05Z');
    const r = await app.tick();
    expect(r.jobs).toMatchObject({ claimed: 1, done: 1 });
    expect(sent(msgs)[1]).toBe('⏰ Reminder: Review the credit workflow');

    // Further ticks (or a second app instance) do not fire it again.
    await app.tick();
    const app2 = boot(t.url, clock, msgs, 'w-other');
    await app2.tick();
    expect(msgs.sent).toHaveLength(2);
    const st = await t.db.query(`SELECT status FROM reminders WHERE id=$1`, [rem.id]);
    expect(st.rows[0].status).toBe('completed');
    await app.close();
    await app2.close();
  });
});

describe('reschedule -> stale job rejected (A02, A03)', () => {
  it('only the current schedule version executes; the superseded job never fires', async () => {
    const clock = new FakeClock(new Date(START));
    const msgs = new FakeMessaging();
    const app = boot(t.url, clock, msgs);
    const rem = await app.reminders.create(o.ownerId, { title: 'Call back Javlon', localDateTime: '2026-10-15T14:00' });
    await app.tick();
    const moved = await app.reminders.reschedule(o.ownerId, rem.id, rem.version, '2026-10-15T16:00');
    expect(moved.scheduleVersion).toBe(2);
    await app.tick();
    expect(sent(msgs)[1]).toContain('Reminder moved: "Call back Javlon" — now 2026-10-15 at 16:00');

    // Time passes beyond BOTH the old (14:00) and new (16:00) times.
    clock.set('2026-10-15T12:00:00Z'); // 17:00 local
    await app.tick();
    const fires = msgs.sent.filter((m) => m.text.startsWith('⏰'));
    expect(fires).toHaveLength(1); // exactly one firing, never two
    const occ = await t.db.query(`SELECT schedule_version, state FROM reminder_occurrences WHERE reminder_id=$1 ORDER BY schedule_version`, [rem.id]);
    expect(occ.rows).toEqual([{ schedule_version: 1, state: 'cancelled' }, { schedule_version: 2, state: 'fired' }]);
    await app.close();
  });

  it('a worker that already claimed the OLD job cannot fire it after a concurrent reschedule', async () => {
    const clock = new FakeClock(new Date(START));
    const msgs = new FakeMessaging();
    const app = boot(t.url, clock, msgs);
    const rem = await app.reminders.create(o.ownerId, { title: 'Race me', localDateTime: '2026-10-15T13:00' });
    clock.set('2026-10-15T08:01:00Z'); // 13:01 local: the original job is due
    const [staleJob] = await claimJobs(app.db, { workerId: 'zombie', leaseMs: 60_000, limit: 1, now: clock.now(), kinds: ['reminder.fire'] });
    expect(staleJob).toBeDefined();
    // Meanwhile the owner reschedules (cancels the job, bumps the fencing token, new schedule version).
    await app.reminders.reschedule(o.ownerId, rem.id, rem.version, '2026-10-15T18:00');
    // The zombie now runs its handler body with the stale claim.
    await expect(fireReminderOccurrence(app.db, staleJob!, { clock })).rejects.toThrow(/lost lease|stale/i);
    expect(msgs.sent.filter((m) => m.text.startsWith('⏰'))).toHaveLength(0);
    const ob = await t.db.query(`SELECT count(*)::int AS n FROM outbox WHERE type='reminder.notify' AND aggregate_id=$1`, [rem.id]);
    expect(ob.rows[0].n).toBe(0); // rolled back: no leaked notification
    await app.close();
  });

  it('cancelling a reminder prevents the pending firing', async () => {
    const clock = new FakeClock(new Date(START));
    const app = boot(t.url, clock);
    const rem = await app.reminders.create(o.ownerId, { title: 'Cancel me', localDateTime: '2026-10-15T13:00' });
    await app.reminders.cancel(o.ownerId, rem.id, rem.version);
    clock.set('2026-10-15T09:00:00Z');
    await app.tick();
    expect(app.messaging.sent.map((m) => m.text).filter((x) => x.startsWith('⏰'))).toHaveLength(0);
    await app.close();
  });

  it('optimistic concurrency: stale expectedVersion is rejected', async () => {
    const clock = new FakeClock(new Date(START));
    const app = boot(t.url, clock);
    const rem = await app.reminders.create(o.ownerId, { title: 'Versioned', localDateTime: '2026-10-15T13:00' });
    await app.reminders.reschedule(o.ownerId, rem.id, rem.version, '2026-10-15T14:00');
    await expect(app.reminders.reschedule(o.ownerId, rem.id, rem.version, '2026-10-15T15:00')).rejects.toMatchObject({ code: 'version_conflict' });
    await app.close();
  });
});

describe('missed-reminder policy, quiet hours, degraded calls, recurrence', () => {
  it('delivers an overdue message reminder once (late label), summarizes one older than 24h', async () => {
    const clock = new FakeClock(new Date(START));
    const app = boot(t.url, clock);
    await app.reminders.create(o.ownerId, { title: 'Late one', localDateTime: '2026-10-15T13:00' }); // 08:00Z
    await app.reminders.create(o.ownerId, { title: 'Ancient one', localDateTime: '2026-10-15T12:30' }); // 07:30Z
    // Server was down: wake up 2h after the first, and >24h after the second? Use two phases.
    clock.set('2026-10-15T10:00:00Z');
    await app.tick();
    const late = app.messaging.sent.find((m) => m.text.includes('Late one') && m.text.startsWith('⏰'));
    expect(late?.text).toBe('⏰ Reminder (late — it was due 2026-10-15 at 13:00): Late one');
    const clock2 = new FakeClock(new Date(START));
    const app2 = boot(t.url, clock2);
    await app2.reminders.create(o.ownerId, { title: 'Stale summary', localDateTime: '2026-10-15T15:00' }); // 10:00Z
    clock2.set('2026-10-17T10:00:00Z'); // 48h later
    await app2.tick();
    const s = app2.messaging.sent.find((m) => m.text.startsWith('You missed'));
    expect(s?.text).toBe('You missed a reminder: "Stale summary" (was due 2026-10-15 at 15:00).');
    await app.close();
    await app2.close();
  });

  it('a call-mode reminder degrades to a clearly labeled message (calls unavailable) — never a silent drop', async () => {
    const clock = new FakeClock(new Date(START));
    const app = boot(t.url, clock);
    await app.reminders.create(o.ownerId, { title: 'Standup call', localDateTime: '2026-10-15T13:00', mode: 'call' });
    clock.set('2026-10-15T08:00:10Z');
    await app.tick();
    const m = app.messaging.sent.find((x) => x.text.includes('Standup call') && x.text.startsWith('⏰'));
    expect(m?.text).toMatch(/calls are not available right now/);
    await app.close();
  });

  it('during quiet hours the reminder is sent silently', async () => {
    const quiet = await seedOwner(t.db);
    const clock = new FakeClock(new Date('2026-10-15T17:30:00Z')); // 22:30 local: inside 22:00-08:00
    const app = boot(t.url, clock);
    await app.reminders.create(quiet.ownerId, { title: 'Night owl', localDateTime: '2026-10-15T22:45' });
    clock.set('2026-10-15T17:46:00Z');
    await app.tick();
    const m = app.messaging.sent.find((x) => x.text.includes('Night owl') && x.text.startsWith('⏰'));
    expect(m?.silent).toBe(true);
    await app.close();
  });

  it('recurring daily reminder fires each day exactly once and keeps the local time', async () => {
    const dailyOwner = await seedOwner(t.db);
    const clock = new FakeClock(new Date('2026-10-15T00:00:00Z'));
    const app = boot(t.url, clock);
    await app.reminders.create(dailyOwner.ownerId, { title: 'Daily standup', localDateTime: '2026-10-15T09:00', recurrence: { freq: 'daily', interval: 1 } });
    for (const day of ['15', '16', '17']) {
      clock.set(`2026-10-${day}T04:00:30Z`);
      await app.tick();
      await app.tick(); // idempotent tick
    }
    const fires = app.messaging.sent.filter((m) => m.text === '⏰ Reminder: Daily standup');
    expect(fires).toHaveLength(3);
    const next = await t.db.query(`SELECT next_occurrence_at FROM reminders WHERE owner_id=$1 AND status='active'`, [dailyOwner.ownerId]);
    expect(next.rows[0].next_occurrence_at.toISOString()).toBe('2026-10-18T04:00:00.000Z');
    await app.close();
  });

  it('rejects a one-off reminder in the past with a clarification-friendly error', async () => {
    const clock = new FakeClock(new Date(START));
    const app = boot(t.url, clock);
    await expect(app.reminders.create(o.ownerId, { title: 'Too late', localDateTime: '2026-10-15T09:00' })).rejects.toMatchObject({ code: 'invalid_input' });
    await app.close();
  });
});

describe('outbox delivery uncertainty (A03)', () => {
  it('a transient send failure is retried and the owner receives the message exactly once', async () => {
    const o3 = await seedOwner(t.db);
    const clock = new FakeClock(new Date(START));
    const msgs = new FakeMessaging();
    const app = boot(t.url, clock, msgs);
    await app.reminders.create(o3.ownerId, { title: 'Flaky network', localDateTime: '2026-10-15T14:00' });
    msgs.failNext = 1;
    await app.tick(); // confirmation fails
    expect(msgs.sent).toHaveLength(0);
    clock.advanceMs(30 * 60_000);
    await app.tick();
    expect(msgs.sent.filter((m) => m.text.startsWith('Reminder set'))).toHaveLength(1);
    await app.close();
  });
});
