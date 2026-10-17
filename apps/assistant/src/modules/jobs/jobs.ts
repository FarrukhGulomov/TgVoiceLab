import type pg from 'pg';
import type { Db, Queryable } from '../../infrastructure/db/db.js';
import { withTimeout } from '../../application/async.js';

export interface EnqueueArgs {
  ownerId: string;
  kind: string;
  payload?: Record<string, unknown>;
  dueAt: Date;
  /** Enqueue is idempotent per dedupe key. */
  dedupeKey?: string;
  maxAttempts?: number;
}

export interface ClaimedJob {
  id: string;
  ownerId: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  fencingToken: string; // bigint as string
  leaseOwner: string;
}

export async function enqueueJob(q: Queryable, a: EnqueueArgs): Promise<{ id: string; created: boolean }> {
  const r = await q.query<{ id: string }>(
    `INSERT INTO jobs (owner_id, kind, payload, due_at, dedupe_key, max_attempts)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [a.ownerId, a.kind, JSON.stringify(a.payload ?? {}), a.dueAt, a.dedupeKey ?? null, a.maxAttempts ?? 5],
  );
  if (r.rows[0]) return { id: r.rows[0].id, created: true };
  const ex = await q.query<{ id: string }>('SELECT id FROM jobs WHERE dedupe_key=$1', [a.dedupeKey]);
  return { id: ex.rows[0]!.id, created: false };
}

/**
 * Claim due jobs with FOR UPDATE SKIP LOCKED. A job whose lease expired is reclaimable; every claim bumps the
 * fencing token, so the previous holder can no longer complete/fail it. Attempts are counted at claim time, so a
 * crash loop cannot exceed max_attempts: exhausted jobs are dead-lettered instead of being handed out again.
 */
export async function claimJobs(db: Db, a: { workerId: string; leaseMs: number; limit: number; now: Date; kinds?: string[] }): Promise<ClaimedJob[]> {
  return db.tx(async (c) => {
    await c.query(
      `UPDATE jobs SET status='dead', last_error=coalesce(last_error,'lease expired after max attempts'), lease_owner=NULL, lease_expires_at=NULL
       WHERE status='leased' AND lease_expires_at < $1 AND attempts >= max_attempts`,
      [a.now],
    );
    const r = await c.query<{
      id: string;
      owner_id: string;
      kind: string;
      payload: Record<string, unknown>;
      attempts: number;
      max_attempts: number;
      fencing_token: string;
    }>(
      `WITH c AS (
         SELECT id FROM jobs
         WHERE ((status='pending' AND due_at <= $1) OR (status='leased' AND lease_expires_at < $1))
           AND ($5::text[] IS NULL OR kind = ANY($5))
         ORDER BY due_at, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT $2)
       UPDATE jobs j SET status='leased', lease_owner=$3, lease_expires_at=$1::timestamptz + ($4 * interval '1 millisecond'),
              fencing_token=j.fencing_token+1, attempts=j.attempts+1
       FROM c WHERE j.id=c.id
       RETURNING j.id, j.owner_id, j.kind, j.payload, j.attempts, j.max_attempts, j.fencing_token`,
      [a.now, a.limit, a.workerId, a.leaseMs, a.kinds ?? null],
    );
    return r.rows.map((x) => ({
      id: x.id,
      ownerId: x.owner_id,
      kind: x.kind,
      payload: x.payload,
      attempts: x.attempts,
      maxAttempts: x.max_attempts,
      fencingToken: x.fencing_token,
      leaseOwner: a.workerId,
    }));
  });
}

export async function renewLease(q: Queryable, j: ClaimedJob, leaseMs: number, now: Date): Promise<boolean> {
  const r = await q.query(
    `UPDATE jobs SET lease_expires_at=$4::timestamptz + ($5 * interval '1 millisecond')
     WHERE id=$1 AND status='leased' AND fencing_token=$2 AND lease_owner=$3`,
    [j.id, j.fencingToken, j.leaseOwner, now, leaseMs],
  );
  return r.rowCount === 1;
}

/** Mark done iff this worker still holds the fencing token. Call inside the same tx as the job's effects. */
export async function completeJob(q: Queryable, j: ClaimedJob): Promise<boolean> {
  const r = await q.query(
    `UPDATE jobs SET status='done', lease_owner=NULL, lease_expires_at=NULL
     WHERE id=$1 AND status='leased' AND fencing_token=$2 AND lease_owner=$3`,
    [j.id, j.fencingToken, j.leaseOwner],
  );
  return r.rowCount === 1;
}

export const backoffMs = (attempt: number, rnd: () => number = Math.random): number => Math.min(15 * 60_000, 2 ** attempt * 1000) * (0.5 + rnd() * 0.5);

export async function failJob(q: Queryable, j: ClaimedJob, error: string, now: Date, rnd: () => number = Math.random): Promise<'retry' | 'dead' | 'lost'> {
  const dead = j.attempts >= j.maxAttempts;
  const r = await q.query(
    `UPDATE jobs SET status=$4, last_error=$5, due_at=$6, lease_owner=NULL, lease_expires_at=NULL
     WHERE id=$1 AND status='leased' AND fencing_token=$2 AND lease_owner=$3`,
    [j.id, j.fencingToken, j.leaseOwner, dead ? 'dead' : 'pending', error.slice(0, 500), new Date(now.getTime() + backoffMs(j.attempts, rnd))],
  );
  if (r.rowCount !== 1) return 'lost';
  return dead ? 'dead' : 'retry';
}

export class LostLeaseError extends Error {
  constructor(jobId: string) {
    super(`lost lease for job ${jobId}`);
    this.name = 'LostLeaseError';
  }
}

export type JobHandler = (job: ClaimedJob, db: Db) => Promise<void>;

export interface RunJobsOptions {
  workerId: string;
  leaseMs: number;
  limit: number;
  now: Date;
  /** Live clock for lease renewal and settlement; defaults to the fixed `now` (deterministic tests). */
  clockNow?: () => Date;
  /** Per-handler time limit. A handler that exceeds it is failed (retry / dead-letter) instead of blocking the lane forever. */
  handlerTimeoutMs?: number;
  onDead?: (j: ClaimedJob, err: string) => Promise<void>;
}

/**
 * One poll iteration: claim, dispatch, and settle. While a handler runs its lease is renewed periodically, so a long job (e.g. a
 * call) is not reclaimed mid-run; if renewal fails the lease is lost and the handler's own fenced `completeJob` will refuse.
 */
export async function runJobsOnce(
  db: Db,
  handlers: Record<string, JobHandler>,
  a: RunJobsOptions,
): Promise<{ claimed: number; done: number; retried: number; dead: number; lost: number }> {
  const jobs = await claimJobs(db, { ...a, kinds: Object.keys(handlers) });
  const nowFn = a.clockNow ?? (() => a.now);
  const out = { claimed: jobs.length, done: 0, retried: 0, dead: 0, lost: 0 };
  for (const j of jobs) {
    const renew = setInterval(() => void renewLease(db, j, a.leaseMs, nowFn()).catch(() => undefined), Math.max(10, Math.floor(a.leaseMs / 3)));
    try {
      const run = handlers[j.kind]!(j, db);
      await (a.handlerTimeoutMs ? withTimeout(run, a.handlerTimeoutMs, `job ${j.kind}`) : run);
      out.done++;
    } catch (e) {
      if (e instanceof LostLeaseError) {
        out.lost++;
        continue;
      }
      const msg = e instanceof Error ? e.message : String(e);
      const res = await failJob(db, j, msg, nowFn());
      if (res === 'retry') out.retried++;
      else if (res === 'dead') {
        out.dead++;
        await a.onDead?.(j, msg);
      } else out.lost++;
    } finally {
      clearInterval(renew);
    }
  }
  return out;
}

export type { pg };
