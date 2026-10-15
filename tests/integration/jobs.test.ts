import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../support/test-db.js';
import { seedOwner, type SeededOwner } from '../support/seed.js';
import { claimJobs, completeJob, enqueueJob, failJob, LostLeaseError, renewLease, runJobsOnce } from '../../apps/assistant/src/modules/jobs/jobs.js';

let t: TestDb;
let o: SeededOwner;
const T0 = new Date('2026-10-15T10:00:00Z');
const plus = (ms: number) => new Date(T0.getTime() + ms);

beforeAll(async () => { t = await createTestDb(); o = await seedOwner(t.db); });
afterAll(async () => { await t.drop(); });

const mk = (kind: string, dueAt = T0, extra: Partial<Parameters<typeof enqueueJob>[1]> = {}) =>
  enqueueJob(t.db, { ownerId: o.ownerId, kind, dueAt, ...extra });

describe('job queue', () => {
  it('enqueue is idempotent per dedupe key', async () => {
    const a = await mk('dedupe', T0, { dedupeKey: 'occ-1' });
    const b = await mk('dedupe', T0, { dedupeKey: 'occ-1' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.id).toBe(a.id);
  });

  it('does not hand out jobs before they are due', async () => {
    await mk('future', plus(60_000));
    const got = await claimJobs(t.db, { workerId: 'w', leaseMs: 1000, limit: 10, now: T0, kinds: ['future'] });
    expect(got).toHaveLength(0);
    const later = await claimJobs(t.db, { workerId: 'w', leaseMs: 1000, limit: 10, now: plus(60_001), kinds: ['future'] });
    expect(later).toHaveLength(1);
  });

  it('concurrent workers never claim the same job twice (SKIP LOCKED)', async () => {
    await Promise.all(Array.from({ length: 40 }, (_, i) => mk('race', T0, { dedupeKey: `race-${i}` })));
    const claims = await Promise.all(Array.from({ length: 8 }, (_, w) => claimJobs(t.db, { workerId: `w${w}`, leaseMs: 60_000, limit: 10, now: T0, kinds: ['race'] })));
    const ids = claims.flat().map((j) => j.id);
    expect(ids).toHaveLength(40);
    expect(new Set(ids).size).toBe(40);
  });

  it('lease expiry makes a job reclaimable and the old holder is fenced out', async () => {
    await mk('lease', T0, { dedupeKey: 'lease-1' });
    const [first] = await claimJobs(t.db, { workerId: 'A', leaseMs: 1000, limit: 1, now: T0, kinds: ['lease'] });
    expect(first).toBeDefined();
    // Still leased: nobody else can take it.
    expect(await claimJobs(t.db, { workerId: 'B', leaseMs: 1000, limit: 1, now: plus(500), kinds: ['lease'] })).toHaveLength(0);
    // Lease expired: B takes over with a higher fencing token.
    const [second] = await claimJobs(t.db, { workerId: 'B', leaseMs: 1000, limit: 1, now: plus(1500), kinds: ['lease'] });
    expect(second!.id).toBe(first!.id);
    expect(BigInt(second!.fencingToken)).toBeGreaterThan(BigInt(first!.fencingToken));
    // A is a zombie: it can neither renew, complete, nor fail.
    expect(await renewLease(t.db, first!, 1000, plus(1600))).toBe(false);
    expect(await completeJob(t.db, first!)).toBe(false);
    expect(await failJob(t.db, first!, 'late', plus(1700))).toBe('lost');
    // B completes normally.
    expect(await completeJob(t.db, second!)).toBe(true);
    const row = await t.db.query('SELECT status FROM jobs WHERE id=$1', [first!.id]);
    expect(row.rows[0].status).toBe('done');
  });

  it('retries with backoff then dead-letters at max attempts, and notifies once', async () => {
    await mk('flaky', T0, { dedupeKey: 'flaky-1', maxAttempts: 3 });
    const dead: string[] = [];
    let now = T0;
    const handlers = { flaky: async () => { throw new Error('boom'); } };
    for (let i = 0; i < 6; i++) {
      await runJobsOnce(t.db, handlers, { workerId: 'w', leaseMs: 1000, limit: 5, now, onDead: async (j) => { dead.push(j.id); } });
      now = new Date(now.getTime() + 20 * 60_000); // beyond max backoff
    }
    const row = await t.db.query('SELECT status, attempts, last_error FROM jobs WHERE dedupe_key=$1', ['flaky-1']);
    expect(row.rows[0]).toMatchObject({ status: 'dead', attempts: 3, last_error: 'boom' });
    expect(dead).toHaveLength(1);
  });

  it('a crash loop (lease expiry without settling) cannot exceed max_attempts', async () => {
    await mk('crashy', T0, { dedupeKey: 'crashy-1', maxAttempts: 2 });
    let now = T0;
    for (let i = 0; i < 5; i++) {
      await claimJobs(t.db, { workerId: `w${i}`, leaseMs: 1000, limit: 1, now, kinds: ['crashy'] });
      now = new Date(now.getTime() + 5000); // worker "crashes"; lease expires
    }
    const row = await t.db.query('SELECT status, attempts FROM jobs WHERE dedupe_key=$1', ['crashy-1']);
    expect(row.rows[0]).toMatchObject({ status: 'dead', attempts: 2 });
  });

  it('LostLeaseError from a handler is not retried or dead-lettered by the zombie', async () => {
    await mk('zombie', T0, { dedupeKey: 'zombie-1' });
    const res = await runJobsOnce(t.db, { zombie: async (j) => { throw new LostLeaseError(j.id); } }, { workerId: 'w', leaseMs: 1000, limit: 5, now: T0 });
    expect(res).toMatchObject({ claimed: 1, lost: 1, done: 0, dead: 0 });
  });

  it('effects and completion commit atomically: a rollback leaves the job leased, not done', async () => {
    await mk('atomic', T0, { dedupeKey: 'atomic-1' });
    const [j] = await claimJobs(t.db, { workerId: 'w', leaseMs: 60_000, limit: 1, now: T0, kinds: ['atomic'] });
    await expect(
      t.db.tx(async (c) => {
        await completeJob(c, j!);
        throw new Error('effect failed after completion mark');
      }),
    ).rejects.toThrow();
    const row = await t.db.query('SELECT status FROM jobs WHERE id=$1', [j!.id]);
    expect(row.rows[0].status).toBe('leased');
  });
});
