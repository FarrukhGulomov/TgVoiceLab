import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../support/test-db.js';
import { seedOwner, type SeededOwner } from '../support/seed.js';
import { boot } from '../support/harness.js';
import { FakeClock } from '../../apps/assistant/src/application/clock.js';
import { FakeMessaging } from '../../apps/assistant/src/testing/fakes.js';
import { dispatchOutboxOnce, emitOutbox } from '../../apps/assistant/src/modules/outbox/outbox.js';
import { claimJobs, enqueueJob, runJobsOnce } from '../../apps/assistant/src/modules/jobs/jobs.js';
import { startLane } from '../../apps/assistant/src/bootstrap/worker.js';
import { ensureRetentionScheduled } from '../../apps/assistant/src/modules/retention/schedule.js';
import { ActiveCallRegistry } from '../../apps/assistant/src/modules/operations/operations.service.js';
import { drainWorker } from '../../apps/assistant/src/bootstrap/worker.js';

/** Audit F07 (fenced outbox), F08 (independent bounded workers), F09 (self-renewing maintenance). */
let t: TestDb;
let o: SeededOwner;
const T0 = new Date('2026-10-15T10:00:00Z');
const plus = (ms: number) => new Date(T0.getTime() + ms);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
beforeEach(async () => {
  t = await createTestDb();
  o = await seedOwner(t.db);
});
afterEach(async () => {
  await t.drop();
});
const emit = (type = 'x.test') => emitOutbox(t.db, { ownerId: o.ownerId, aggregateType: 'thing', aggregateId: crypto.randomUUID(), type }, T0);
const state = async (id: string) => (await t.db.query('SELECT delivery_state, delivered_at, attempts, last_error FROM outbox WHERE event_id=$1', [id])).rows[0];

describe('F07 — outbox settlement is fenced', () => {
  it('a worker whose lease expired cannot settle or overwrite the newer holder', async () => {
    const id = await emit();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered = false;
    const slowFail = {
      'x.test': async () => {
        entered = true;
        await gate;
        throw new Error('late failure from stale worker');
      },
    };
    const A = dispatchOutboxOnce(t.db, slowFail, { workerId: 'A', now: T0, leaseMs: 1000 });
    while (!entered) await sleep(5);
    // A's lease expired; B reclaims and delivers.
    const B = await dispatchOutboxOnce(t.db, { 'x.test': async () => undefined }, { workerId: 'B', now: plus(5000), leaseMs: 1000 });
    expect(B.delivered).toBe(1);
    release();
    await A;
    const s = await state(id);
    expect(s.delivery_state).toBe('delivered'); // A's late failure did not flip it back to pending
    expect(s.last_error).toBeNull();
  });
  it('a stale worker success after reclaim does not overwrite a newer holder either', async () => {
    const id = await emit();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered = false;
    const A = dispatchOutboxOnce(
      t.db,
      {
        'x.test': async () => {
          entered = true;
          await gate;
        },
      },
      { workerId: 'A', now: T0, leaseMs: 1000 },
    );
    while (!entered) await sleep(5);
    let bEntered = false;
    let bRelease!: () => void;
    const bGate = new Promise<void>((r) => (bRelease = r));
    const Bp = dispatchOutboxOnce(
      t.db,
      {
        'x.test': async () => {
          bEntered = true;
          await bGate;
          throw new Error('B failed');
        },
      },
      { workerId: 'B', now: plus(5000), leaseMs: 1000 },
    );
    while (!bEntered) await sleep(5);
    release(); // stale A finishes first and tries to mark delivered
    await A;
    expect((await state(id)).delivery_state).toBe('pending'); // fenced: B holds the row
    bRelease();
    await Bp;
    expect((await state(id)).delivery_state).toBe('pending'); // B's own failure is recorded for retry
  });
  it('crash-only retries are capped at claim time: an exhausted row is dead-lettered, never handed out again', async () => {
    const id = await emit();
    await t.db.query(`UPDATE outbox SET attempts=8, lease_owner='crashed', lease_expires_at=$2 WHERE event_id=$1`, [id, T0]);
    let called = 0;
    const r = await dispatchOutboxOnce(t.db, { 'x.test': async () => void called++ }, { workerId: 'B', now: plus(5000), maxAttempts: 8 });
    expect(called).toBe(0);
    expect(r.delivered).toBe(0);
    expect((await state(id)).delivery_state).toBe('dead');
  });
  it('retry scheduling uses the settlement-time clock, not the batch start time', async () => {
    const id = await emit();
    const clockNow = { v: T0 };
    await dispatchOutboxOnce(
      t.db,
      {
        'x.test': async () => {
          clockNow.v = plus(10 * 60_000);
          throw new Error('slow then fail');
        },
      },
      { workerId: 'A', now: T0, clockNow: () => clockNow.v },
    );
    const next = (await t.db.query('SELECT next_attempt_at FROM outbox WHERE event_id=$1', [id])).rows[0].next_attempt_at as Date;
    expect(next.getTime()).toBeGreaterThan(plus(10 * 60_000).getTime());
  });
});

describe('F08 — slow work does not block text delivery; polling never overlaps', () => {
  it('a hanging call job does not delay a due text reminder', async () => {
    const clock = new FakeClock(new Date('2026-10-15T07:00:00Z'));
    const app = boot(t.url, clock, new FakeMessaging(), 'w', {
      extraJobHandlers: { 'test.slow_call': { lane: 'calls', handler: () => new Promise<void>(() => undefined) } },
    });
    await enqueueJob(t.db, { ownerId: o.ownerId, kind: 'test.slow_call', dueAt: clock.now(), dedupeKey: 'slow-1' });
    await app.reminders.create(o.ownerId, { title: 'water', localDateTime: '2026-10-15T12:01' });
    clock.set('2026-10-15T07:02:00Z');
    void app.tickLane('calls'); // never finishes: a long call
    await sleep(50);
    const fast = await app.tickLane('jobs');
    await app.tickLane('outbox');
    expect(fast).toMatchObject({ claimed: 1, done: 1 }); // the reminder job
    expect(app.messaging.sent.map((m) => m.text).some((x) => /Reminder: water/.test(x))).toBe(true);
    await app.close();
  });
  it('a lane never overlaps itself: a 120 ms tick at a 10 ms interval accumulates no backlog', async () => {
    let running = 0;
    let maxRunning = 0;
    let calls = 0;
    const lane = startLane({
      name: 'slow',
      intervalMs: 10,
      run: async () => {
        calls++;
        running++;
        maxRunning = Math.max(maxRunning, running);
        await sleep(120);
        running--;
      },
      onError: () => undefined,
    });
    await sleep(500);
    await lane.stop();
    expect(maxRunning).toBe(1);
    expect(calls).toBeLessThanOrEqual(5);
    expect(running).toBe(0); // stop() waited for the in-flight tick
  });
  it('a lane survives errors and keeps polling', async () => {
    let calls = 0;
    const errors: string[] = [];
    const lane = startLane({
      name: 'flaky',
      intervalMs: 5,
      run: async () => {
        if (++calls < 3) throw new Error('boom');
      },
      onError: (e) => errors.push(e.message),
    });
    await sleep(100);
    await lane.stop();
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(errors).toEqual(['boom', 'boom']);
  });
  it('a long job keeps its lease via renewal, so another worker cannot claim it mid-run', async () => {
    await enqueueJob(t.db, { ownerId: o.ownerId, kind: 'long', dueAt: new Date(Date.now() - 1000), dedupeKey: 'long-1' });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started = false;
    const run = runJobsOnce(
      t.db,
      {
        long: async () => {
          started = true;
          await gate;
        },
      },
      { workerId: 'A', leaseMs: 90, limit: 1, now: new Date(), clockNow: () => new Date() },
    );
    while (!started) await sleep(5);
    await sleep(400); // several lease periods
    const stolen = await claimJobs(t.db, { workerId: 'B', leaseMs: 90, limit: 1, now: new Date(), kinds: ['long'] });
    expect(stolen).toHaveLength(0);
    release();
    await run;
  });
  it('drainWorker stops claims and asks every live call to end before exiting', async () => {
    const registry = new ActiveCallRegistry();
    const ended: string[] = [];
    registry.add({ callId: 'c1', ownerId: o.ownerId, contactId: null, end: async (r) => void ended.push(`c1:${r}`) });
    registry.add({ callId: 'c2', ownerId: o.ownerId, contactId: null, end: async (r) => void ended.push(`c2:${r}`) });
    let stopped = 0;
    await drainWorker({ lanes: [{ stop: async () => void stopped++ }, { stop: async () => void stopped++ }], registry, deadlineMs: 1000 });
    expect(stopped).toBe(2);
    expect(ended.sort()).toEqual(['c1:cancelled', 'c2:cancelled']);
  });
});

describe('F09 — retention and maintenance renew themselves without restarts', () => {
  it('sweeps once per day across several days with no restart; duplicate schedulers are harmless', async () => {
    const day = (n: number) => new Date(Date.UTC(2026, 9, 15 + n, 0, 0, 0));
    const clock = new FakeClock(day(0));
    const app = boot(t.url, clock);
    await ensureRetentionScheduled(t.db, o.ownerId, clock.now());
    await ensureRetentionScheduled(t.db, o.ownerId, clock.now()); // second scheduler: no duplicate
    const conv = (
      await t.db.query<{ id: string }>(`INSERT INTO conversations (owner_id, actor_role, channel) VALUES ($1,'owner','telegram_text') RETURNING id`, [
        o.ownerId,
      ])
    ).rows[0]!.id;
    for (let i = 1; i <= 3; i++)
      await t.db.query(
        `INSERT INTO messages (owner_id, conversation_id, account_id, provider_message_id, direction, content_enc, occurred_at, retention_expires_at) VALUES ($1,$2,$3,$4,'inbound','e1.x',$5,$6)`,
        [o.ownerId, conv, o.accountId, `m${i}`, day(0), new Date(day(i).getTime() - 3600_000)],
      );
    const left = async () => (await t.db.query('SELECT count(*)::int n FROM messages')).rows[0].n as number;
    expect(await left()).toBe(3);
    const seen: number[] = [];
    for (let i = 1; i <= 3; i++) {
      clock.set(new Date(day(i).getTime() + 2 * 3600_000)); // 02:00 UTC next day
      await app.tickLane('jobs');
      seen.push(await left());
    }
    expect(seen).toEqual([2, 1, 0]); // exactly one sweep per day, no restart
    await app.close();
  });
  it('catches up after downtime with a single sweep and schedules only the next day (no burst)', async () => {
    const clock = new FakeClock(new Date('2026-10-15T00:00:00Z'));
    const app = boot(t.url, clock);
    await ensureRetentionScheduled(t.db, o.ownerId, clock.now());
    clock.set(new Date('2026-10-20T12:00:00Z')); // five days of downtime
    await app.tickLane('jobs');
    const pending = await t.db.query(`SELECT dedupe_key, due_at FROM jobs WHERE kind='retention.sweep' AND status='pending'`);
    expect(pending.rows).toHaveLength(1);
    expect((pending.rows[0].due_at as Date).getTime()).toBeGreaterThan(new Date('2026-10-20T12:00:00Z').getTime());
    expect((pending.rows[0].due_at as Date).getTime()).toBeLessThanOrEqual(new Date('2026-10-21T12:00:00Z').getTime());
    await app.close();
  });
});
