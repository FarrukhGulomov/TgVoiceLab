import type { Queryable } from '../../infrastructure/db/db.js';
import { enqueueJob } from '../jobs/jobs.js';

export const RETENTION_JOB = 'retention.sweep';
const HOUR = 3600_000;

/** The next sweep: 01:00 UTC on the UTC day after `now` (one per day, however long the process was down). */
export function nextRetentionDue(now: Date): { dueAt: Date; day: string } {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0) + HOUR);
  return { dueAt: next, day: next.toISOString().slice(0, 10) };
}

/**
 * Idempotently make sure a sweep is scheduled: one is due immediately (startup catch-up) unless one is already pending. Duplicate
 * schedulers are harmless because every job carries a per-day dedupe key.
 */
export async function ensureRetentionScheduled(q: Queryable, ownerId: string, now: Date): Promise<void> {
  const pending = await q.query(`SELECT 1 FROM jobs WHERE kind=$1 AND owner_id=$2 AND status IN ('pending','leased') LIMIT 1`, [RETENTION_JOB, ownerId]);
  if (pending.rowCount) return;
  await enqueueJob(q, { ownerId, kind: RETENTION_JOB, dueAt: now, dedupeKey: `retention:${ownerId}:${now.toISOString().slice(0, 10)}:catchup` });
}

/** Called in the same transaction that completes a sweep: schedule the successor so maintenance never depends on restarts. */
export async function scheduleNextRetention(q: Queryable, ownerId: string, now: Date): Promise<void> {
  const { dueAt, day } = nextRetentionDue(now);
  await enqueueJob(q, { ownerId, kind: RETENTION_JOB, dueAt, dedupeKey: `retention:${ownerId}:${day}` });
}
