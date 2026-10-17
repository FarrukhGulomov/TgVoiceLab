import type { Db, Queryable } from '../../infrastructure/db/db.js';
import { backoffMs } from '../jobs/jobs.js';
import { withTimeout } from '../../application/async.js';

export interface OutboxEvent {
  ownerId: string;
  aggregateType: string;
  aggregateId: string;
  type: string;
  version?: number;
  /** Minimal routing data. Never raw conversation content. */
  payload?: Record<string, unknown>;
}

/** Write inside the same transaction as the state change it describes. */
export async function emitOutbox(q: Queryable, e: OutboxEvent, now: Date): Promise<string> {
  const r = await q.query<{ event_id: string }>(
    `INSERT INTO outbox (owner_id, aggregate_type, aggregate_id, type, version, payload, created_at, next_attempt_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING event_id`,
    [e.ownerId, e.aggregateType, e.aggregateId, e.type, e.version ?? 1, JSON.stringify(e.payload ?? {}), now],
  );
  return r.rows[0]!.event_id;
}

export interface OutboxRow {
  eventId: string;
  ownerId: string;
  aggregateType: string;
  aggregateId: string;
  type: string;
  version: number;
  payload: Record<string, unknown>;
  attempts: number;
}

export type OutboxHandler = (row: OutboxRow) => Promise<void>;

export interface DispatchOptions {
  workerId: string;
  /** Time used for claiming (lease start). */
  now: Date;
  /** Time used for settlement and retry scheduling; defaults to `now`. Pass the live clock so slow handlers do not skew retries. */
  clockNow?: () => Date;
  limit?: number;
  leaseMs?: number;
  maxAttempts?: number;
  /** Must stay below `leaseMs` so a hung handler cannot outlive its lease. */
  handlerTimeoutMs?: number;
}

/**
 * At-least-once delivery. Each row is claimed individually (SKIP LOCKED) right before its handler runs, so a slow predecessor
 * cannot make later rows' leases expire while they wait. Every claim bumps a fencing token and settlement must present it:
 * a worker whose lease expired can no longer mark the row delivered or failed over a newer holder (audit F07). Attempts are
 * counted at claim time and exhausted rows are dead-lettered instead of being handed out again, so crash loops terminate.
 * A crash after delivery but before marking still means redelivery, so handlers MUST be idempotent on `eventId`
 * (e.g. use it as the Telegram random_id).
 */
export async function dispatchOutboxOnce(
  db: Db,
  handlers: Record<string, OutboxHandler>,
  a: DispatchOptions,
): Promise<{ delivered: number; failed: number; dead: number; lost: number }> {
  const leaseMs = a.leaseMs ?? 60_000;
  const maxAttempts = a.maxAttempts ?? 8;
  const nowFn = a.clockNow ?? (() => a.now);
  const handlerTimeoutMs = a.handlerTimeoutMs ?? Math.max(1000, Math.floor(leaseMs * 0.75));
  const types = Object.keys(handlers);
  const out = { delivered: 0, failed: 0, dead: 0, lost: 0 };

  // Crash-only retries: a row whose lease expired with no attempts left is dead-lettered, never redelivered.
  await db.query(
    `UPDATE outbox SET delivery_state='dead', last_error=coalesce(last_error,'lease expired after max attempts'), lease_owner=NULL, lease_expires_at=NULL
     WHERE delivery_state='pending' AND attempts >= $2 AND lease_expires_at IS NOT NULL AND lease_expires_at < $1 AND type = ANY($3)`,
    [nowFn(), maxAttempts, types],
  );

  for (let i = 0; i < (a.limit ?? 20); i++) {
    const claimAt = nowFn();
    const claimed = await db.query<{
      event_id: string;
      owner_id: string;
      aggregate_type: string;
      aggregate_id: string;
      type: string;
      version: number;
      payload: Record<string, unknown>;
      attempts: number;
      fencing_token: string;
    }>(
      `WITH c AS (
         SELECT event_id FROM outbox
         WHERE delivery_state='pending' AND next_attempt_at <= $1 AND (lease_expires_at IS NULL OR lease_expires_at < $1)
           AND type = ANY($4) AND attempts < $5
         ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
       UPDATE outbox o SET lease_owner=$2, lease_expires_at=$1::timestamptz + ($3 * interval '1 millisecond'),
              attempts=o.attempts+1, fencing_token=o.fencing_token+1
       FROM c WHERE o.event_id=c.event_id
       RETURNING o.event_id, o.owner_id, o.aggregate_type, o.aggregate_id, o.type, o.version, o.payload, o.attempts, o.fencing_token`,
      [claimAt, a.workerId, leaseMs, types, maxAttempts],
    );
    const r = claimed.rows[0];
    if (!r) break;
    const row: OutboxRow = {
      eventId: r.event_id,
      ownerId: r.owner_id,
      aggregateType: r.aggregate_type,
      aggregateId: r.aggregate_id,
      type: r.type,
      version: r.version,
      payload: r.payload,
      attempts: r.attempts,
    };
    const fence = [row.eventId, r.fencing_token, a.workerId];
    try {
      await withTimeout(handlers[row.type]!(row), handlerTimeoutMs, `outbox handler ${row.type}`);
      const res = await db.query(
        `UPDATE outbox SET delivery_state='delivered', delivered_at=$4, lease_owner=NULL, lease_expires_at=NULL
         WHERE event_id=$1 AND fencing_token=$2 AND lease_owner=$3 AND delivery_state='pending'`,
        [...fence, nowFn()],
      );
      if (res.rowCount === 1) out.delivered++;
      else out.lost++;
    } catch (err) {
      const permanent = (err as { permanent?: boolean })?.permanent === true;
      const dead = permanent || row.attempts >= maxAttempts; // a deterministic provider rejection is never retried
      const res = await db.query(
        `UPDATE outbox SET delivery_state=$4, next_attempt_at=$5, last_error=$6, lease_owner=NULL, lease_expires_at=NULL
         WHERE event_id=$1 AND fencing_token=$2 AND lease_owner=$3 AND delivery_state='pending'`,
        [
          ...fence,
          dead ? 'dead' : 'pending',
          new Date(nowFn().getTime() + backoffMs(row.attempts)),
          (err instanceof Error ? err.message : String(err)).slice(0, 500),
        ],
      );
      if (res.rowCount !== 1) out.lost++;
      else if (dead) out.dead++;
      else out.failed++;
    }
  }
  return out;
}
