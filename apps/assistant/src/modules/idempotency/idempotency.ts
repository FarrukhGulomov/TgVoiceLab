import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { Db } from '../../infrastructure/db/db.js';
import type { DataCrypto } from '../../infrastructure/crypto/data-crypto.js';

/** AAD label for sealed idempotency responses (audit F10): they replay task titles and call plans, so they are not stored in clear. */
export const IDEMPOTENCY_AAD_COLUMN = 'idempotency_keys.response';

export type IdempotentOutcome<T> = { kind: 'executed'; status: number; body: T } | { kind: 'replayed'; status: number; body: T } | { kind: 'conflict' };

export const hashRequest = (body: unknown): string => createHash('sha256').update(canonicalJson(body)).digest('hex');

/** Deterministic JSON (sorted keys) so semantically equal bodies hash equally. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}

/**
 * Run `handler` at most once per (owner, action, key). The key row and the handler's writes commit atomically, so a
 * crash or rollback leaves no half-recorded key. Same key + different body => `conflict` (HTTP 409).
 */
export async function runIdempotent<T>(
  db: Db,
  args: { ownerId: string; action: string; key: string; requestBody: unknown; ttlMs?: number; now: Date; crypto: DataCrypto },
  handler: (c: pg.PoolClient) => Promise<{ status: number; body: T; afterCommit?: () => Promise<void> }>,
): Promise<IdempotentOutcome<T>> {
  const reqHash = hashRequest(args.requestBody);
  let after: (() => Promise<void>) | undefined;
  const out = await db.tx(async (c) => {
    const ins = await c.query(
      `INSERT INTO idempotency_keys (owner_id, action, key, request_hash, expires_at)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (owner_id, action, key) DO NOTHING RETURNING id`,
      [args.ownerId, args.action, args.key, reqHash, new Date(args.now.getTime() + (args.ttlMs ?? 24 * 3600_000))],
    );
    if (ins.rowCount === 0) {
      const prev = await c.query<{ request_hash: string; state: string; status_code: number; response: T }>(
        `SELECT request_hash, state, status_code, response FROM idempotency_keys WHERE owner_id=$1 AND action=$2 AND key=$3`,
        [args.ownerId, args.action, args.key],
      );
      const row = prev.rows[0]!;
      if (row.request_hash !== reqHash) return { kind: 'conflict' } as const;
      // Sealed responses are a JSON string holding the ciphertext; rows written before sealing existed are plain objects.
      const body = typeof row.response === 'string' ? (JSON.parse(args.crypto.dec(args.ownerId, IDEMPOTENCY_AAD_COLUMN, row.response)) as T) : row.response;
      return { kind: 'replayed', status: row.status_code, body } as const;
    }
    const out = await handler(c);
    await c.query(`UPDATE idempotency_keys SET state='done', status_code=$4, response=$5 WHERE owner_id=$1 AND action=$2 AND key=$3`, [
      args.ownerId,
      args.action,
      args.key,
      out.status,
      JSON.stringify(args.crypto.enc(args.ownerId, IDEMPOTENCY_AAD_COLUMN, JSON.stringify(out.body))),
    ]);
    after = out.afterCommit;
    return { kind: 'executed', status: out.status, body: out.body } as const;
  });
  // External effects (ending a live call) run only AFTER the transaction committed, never while holding it. If the process dies
  // in this window the effect is not repeated on retry (the key replays); a live call dies with the process anyway.
  if (out.kind === 'executed' && after) await after();
  return out;
}
