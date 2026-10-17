import type { Db } from '../../infrastructure/db/db.js';
import { aad, type Envelope } from '../../infrastructure/crypto/envelope.js';

/** Every encrypted column: (table, id column, ciphertext column, AAD column label — must match what the writing code uses). */
const TARGETS = [
  { table: 'tasks', col: 'title_enc', label: 'tasks.title' },
  { table: 'tasks', col: 'description_enc', label: 'tasks.description' },
  { table: 'reminders', col: 'title_enc', label: 'reminders.title' },
  { table: 'messages', col: 'content_enc', label: 'messages.content' },
  { table: 'memories', col: 'value_enc', label: 'memories.value' },
  { table: 'call_reports', col: 'narrative_enc', label: 'call_reports.narrative', id: 'call_id' },
  { table: 'call_requests', col: 'plan_enc', label: 'call_requests.plan' },
] as const;

/** Ciphertext locations that are not a plain text column. */
const ARRAY_TARGET = { table: 'contact_permissions', col: 'context_allowlist', label: 'contact_permissions.context_allowlist' } as const;
const JSON_STRING_TARGET = { table: 'idempotency_keys', col: 'response', label: 'idempotency_keys.response' } as const;

export interface RotationResult {
  reencrypted: number;
  remainingOnOldKeys: number;
}

/**
 * Re-encrypt every envelope that is not under the active key. Safe to re-run (idempotent) and to interrupt (each batch is its own tx).
 * After `remainingOnOldKeys === 0` the retired key may be removed from the key ring. Transient `outbox.payload.textEnc` values are not
 * rewritten (delivered rows are purged within 7 days); drain the outbox before removing a key. Sealed idempotency responses are
 * rewritten too, but they are replay data with a 24 h TTL.
 */
export async function rotateKeys(db: Db, envelope: Envelope, opts: { batchSize?: number } = {}): Promise<RotationResult> {
  const batch = opts.batchSize ?? 200;
  const prefix = envelope.activePrefix;
  let reencrypted = 0;
  let remaining = 0;
  for (const t of TARGETS) {
    const id = 'id' in t ? t.id : 'id';
    // Select exactly the rows NOT under the active key (no OFFSET paging: always makes progress). left()/length() instead of LIKE
    // so key ids containing '_' or '%' cannot act as wildcards.
    const stale = `${t.col} IS NOT NULL AND left(${t.col}, length($1)) <> $1`;
    for (;;) {
      const rows = await db.query<{ id: string; owner_id: string; v: string }>(
        `SELECT ${id} AS id, owner_id, ${t.col} AS v FROM ${t.table} WHERE ${stale} ORDER BY ${id} LIMIT ${batch}`,
        [prefix],
      );
      if (!rows.rows.length) break;
      await db.tx(async (c) => {
        for (const r of rows.rows) {
          const plain = envelope.decrypt(r.v, aad(r.owner_id, t.label));
          const upd = await c.query(`UPDATE ${t.table} SET ${t.col}=$1 WHERE ${id}=$2 AND ${t.col}=$3`, [
            envelope.encrypt(plain, aad(r.owner_id, t.label)),
            r.id,
            r.v,
          ]);
          reencrypted += upd.rowCount ?? 0;
        }
      });
    }
    remaining += (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t.table} WHERE ${stale}`, [prefix])).rows[0]!.n;
  }

  // text[] of sealed entries (permission context).
  {
    const t = ARRAY_TARGET;
    const stale = `EXISTS (SELECT 1 FROM unnest(${t.col}) e WHERE left(e, length($1)) <> $1)`;
    for (;;) {
      const rows = await db.query<{ id: string; owner_id: string; v: string[] }>(
        `SELECT id, owner_id, ${t.col} AS v FROM ${t.table} WHERE ${stale} ORDER BY id LIMIT ${batch}`,
        [prefix],
      );
      if (!rows.rows.length) break;
      await db.tx(async (c) => {
        for (const r of rows.rows) {
          const next = r.v.map((e) => (e.startsWith(prefix) ? e : envelope.encrypt(envelope.decrypt(e, aad(r.owner_id, t.label)), aad(r.owner_id, t.label))));
          const upd = await c.query(`UPDATE ${t.table} SET ${t.col}=$1 WHERE id=$2 AND ${t.col}=$3`, [next, r.id, r.v]);
          reencrypted += upd.rowCount ?? 0;
        }
      });
    }
    remaining += (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t.table} WHERE ${stale}`, [prefix])).rows[0]!.n;
  }

  // jsonb string holding a sealed idempotency response (rows expire after 24 h; plain-object legacy rows are not ciphertext).
  {
    const t = JSON_STRING_TARGET;
    const stale = `jsonb_typeof(${t.col}) = 'string' AND left(${t.col} #>> '{}', length($1)) <> $1`;
    for (;;) {
      const rows = await db.query<{ id: string; owner_id: string; v: string }>(
        `SELECT id, owner_id, ${t.col} #>> '{}' AS v FROM ${t.table} WHERE ${stale} ORDER BY id LIMIT ${batch}`,
        [prefix],
      );
      if (!rows.rows.length) break;
      await db.tx(async (c) => {
        for (const r of rows.rows) {
          const next = envelope.encrypt(envelope.decrypt(r.v, aad(r.owner_id, t.label)), aad(r.owner_id, t.label));
          const upd = await c.query(`UPDATE ${t.table} SET ${t.col}=to_jsonb($1::text) WHERE id=$2 AND ${t.col} #>> '{}' = $3`, [next, r.id, r.v]);
          reencrypted += upd.rowCount ?? 0;
        }
      });
    }
    remaining += (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t.table} WHERE ${stale}`, [prefix])).rows[0]!.n;
  }
  return { reencrypted, remainingOnOldKeys: remaining };
}
