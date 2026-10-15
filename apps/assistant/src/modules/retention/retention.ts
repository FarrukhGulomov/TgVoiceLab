import type { Db } from '../../infrastructure/db/db.js';

/** Defaults from spec §9.2; configurable before launch. Raw recordings are disabled by default, so they have no table here. */
export const RETENTION = {
  messagesMs: 30 * 24 * 3600_000,
  reportsMs: 30 * 24 * 3600_000,
  auditMs: 90 * 24 * 3600_000,
  doneJobsMs: 7 * 24 * 3600_000,
  deliveredOutboxMs: 7 * 24 * 3600_000,
} as const;

export interface RetentionResult {
  messages: number;
  reports: number;
  memories: number;
  audit: number;
  idempotency: number;
  jobs: number;
  outbox: number;
}

/**
 * Daily deletion sweep. Content deletions write tombstones in the same transaction so a restored backup can be re-purged
 * (`replayTombstones`). Deletion from immutable backups is NOT instant: backups expire after 30 days (documented, not hidden).
 */
export async function runRetention(db: Db, now: Date): Promise<RetentionResult> {
  return db.tx(async (c) => {
    await c.query(`SELECT set_config('app.retention_delete','on',true)`); // allows DELETE on append-only tables, this tx only
    const del = async (table: string, type: string, where: string, params: unknown[]) => {
      const r = await c.query<{ id: string; owner_id: string }>(
        `DELETE FROM ${table} WHERE ${where} RETURNING ${table === 'call_reports' ? 'call_id' : 'id'} AS id, owner_id`,
        params,
      );
      for (const row of r.rows)
        await c.query(`INSERT INTO deletion_tombstones (owner_id, resource_type, resource_id, deleted_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [
          row.owner_id,
          type,
          row.id,
          now,
        ]);
      return r.rowCount ?? 0;
    };
    const out: RetentionResult = {
      messages: await del('messages', 'message', 'retention_expires_at IS NOT NULL AND retention_expires_at < $1', [now]),
      reports: await del('call_reports', 'call_report', 'created_at < $1', [new Date(now.getTime() - RETENTION.reportsMs)]),
      memories: await del('memories', 'memory', 'expires_at IS NOT NULL AND expires_at < $1', [now]),
      audit: (await c.query('DELETE FROM audit_events WHERE created_at < $1', [new Date(now.getTime() - RETENTION.auditMs)])).rowCount ?? 0,
      idempotency: (await c.query('DELETE FROM idempotency_keys WHERE expires_at < $1', [now])).rowCount ?? 0,
      jobs:
        (await c.query(`DELETE FROM jobs WHERE status IN ('done','cancelled') AND updated_at < $1`, [new Date(now.getTime() - RETENTION.doneJobsMs)]))
          .rowCount ?? 0,
      outbox:
        (await c.query(`DELETE FROM outbox WHERE delivery_state='delivered' AND delivered_at < $1`, [new Date(now.getTime() - RETENTION.deliveredOutboxMs)]))
          .rowCount ?? 0,
    };
    return out;
  });
}

const TOMBSTONE_TABLES: Record<string, { table: string; idCol: string }> = {
  message: { table: 'messages', idCol: 'id' },
  call_report: { table: 'call_reports', idCol: 'call_id' },
  memory: { table: 'memories', idCol: 'id' },
};

/** After a backup restore: re-apply every recorded deletion so deleted content does not resurface. Idempotent. */
export async function replayTombstones(db: Db): Promise<{ purged: number }> {
  let purged = 0;
  await db.tx(async (c) => {
    await c.query(`SELECT set_config('app.retention_delete','on',true)`);
    for (const [type, { table, idCol }] of Object.entries(TOMBSTONE_TABLES)) {
      const r = await c.query(`DELETE FROM ${table} WHERE ${idCol} IN (SELECT resource_id FROM deletion_tombstones WHERE resource_type=$1)`, [type]);
      purged += r.rowCount ?? 0;
    }
  });
  return { purged };
}
