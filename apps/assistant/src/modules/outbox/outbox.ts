import type { Db, Queryable } from '../../infrastructure/db/db.js';
import { backoffMs } from '../jobs/jobs.js';

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

/**
 * At-least-once delivery. Rows are leased (SKIP LOCKED) while being delivered; a crash after delivery but before
 * marking means redelivery, so handlers MUST be idempotent on `eventId` (e.g. use it as the Telegram random_id).
 */
export async function dispatchOutboxOnce(
  db: Db,
  handlers: Record<string, OutboxHandler>,
  a: { workerId: string; now: Date; limit?: number; leaseMs?: number; maxAttempts?: number },
): Promise<{ delivered: number; failed: number; dead: number }> {
  const leaseMs = a.leaseMs ?? 60_000;
  const rows = await db.query<{
    event_id: string;
    owner_id: string;
    aggregate_type: string;
    aggregate_id: string;
    type: string;
    version: number;
    payload: Record<string, unknown>;
    attempts: number;
  }>(
    `WITH c AS (
       SELECT event_id FROM outbox
       WHERE delivery_state='pending' AND next_attempt_at <= $1 AND (lease_expires_at IS NULL OR lease_expires_at < $1)
         AND type = ANY($5)
       ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $2)
     UPDATE outbox o SET lease_owner=$3, lease_expires_at=$1::timestamptz + ($4 * interval '1 millisecond'), attempts=o.attempts+1
     FROM c WHERE o.event_id=c.event_id
     RETURNING o.event_id, o.owner_id, o.aggregate_type, o.aggregate_id, o.type, o.version, o.payload, o.attempts`,
    [a.now, a.limit ?? 20, a.workerId, leaseMs, Object.keys(handlers)],
  );
  const out = { delivered: 0, failed: 0, dead: 0 };
  for (const r of rows.rows) {
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
    try {
      await handlers[row.type]!(row);
      await db.query(`UPDATE outbox SET delivery_state='delivered', delivered_at=$2, lease_owner=NULL, lease_expires_at=NULL WHERE event_id=$1`, [
        row.eventId,
        a.now,
      ]);
      out.delivered++;
    } catch (err) {
      const dead = row.attempts >= (a.maxAttempts ?? 8);
      await db.query(`UPDATE outbox SET delivery_state=$2, next_attempt_at=$3, last_error=$4, lease_owner=NULL, lease_expires_at=NULL WHERE event_id=$1`, [
        row.eventId,
        dead ? 'dead' : 'pending',
        new Date(a.now.getTime() + backoffMs(row.attempts)),
        (err instanceof Error ? err.message : String(err)).slice(0, 500),
      ]);
      if (dead) out.dead++;
      else out.failed++;
    }
  }
  return out;
}
