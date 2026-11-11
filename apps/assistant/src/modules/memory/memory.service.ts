import { randomUUID } from 'node:crypto';
import type { DataCrypto } from '../../infrastructure/crypto/data-crypto.js';
import type { Queryable } from '../../infrastructure/db/db.js';

/**
 * Owner-controlled memory: short facts the assistant keeps so it can understand later messages and calls like a person who
 * remembers. Everything is encrypted at rest and scoped:
 *   `owner:notes`            what the owner asked to remember;
 *   `contact:<id>:notes`     what was learnt in calls with / about that contact (only ever shown to calls with that contact).
 * Only approved, unexpired, non-superseded rows are retrievable; the owner can list and delete them. Contact-scoped memory is never
 * given to any other contact.
 */
export const OWNER_SCOPE = 'owner:notes';
/** What the assistant learnt from its own calls (what to do better). Kept apart so it can never push the owner's notes out of their capped scope. */
export const LESSON_SCOPE = 'owner:lessons';
export const contactScope = (contactId: string): string => `contact:${contactId}:notes`;

export const MEMORY_TEXT_MAX = 400;
/** Facts kept per scope; the oldest are retired when a new one would exceed it. */
export const MEMORY_PER_SCOPE = 60;

export interface MemoryItem {
  id: string;
  scope: string;
  text: string;
  createdAt: Date;
  source: string;
}

const clean = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, MEMORY_TEXT_MAX);
const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const tokens = (x: string): Set<string> => new Set(x.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
/** Almost the same words (>= 85% overlap both ways): a re-worded duplicate that only adds noise to recall. Different numbers make a different fact. */
export function nearlySame(a: string, b: string): boolean {
  const x = tokens(a);
  const y = tokens(b);
  if (x.size < 4 || y.size < 4) return false;
  const nums = (t: Set<string>) =>
    [...t]
      .filter((w) => /\d/.test(w))
      .sort()
      .join(',');
  if (nums(x) !== nums(y)) return false; // a different number (price, time) is a different fact
  let common = 0;
  for (const w of x) if (y.has(w)) common++;
  return common / x.size >= 0.85 && common / y.size >= 0.85;
}

export class MemoryService {
  constructor(private readonly crypto: DataCrypto) {}

  /** Stores one fact. A fact equal (ignoring case and punctuation) to an existing one is not stored twice. Returns null if nothing was stored. */
  async remember(
    q: Queryable,
    ownerId: string,
    scope: string,
    text: string,
    prov: { source: 'owner_command' | 'call_report' | 'assistant'; callId?: string },
    now: Date,
    opts: { confidence?: number; expiresAt?: Date } = {},
  ): Promise<MemoryItem | null> {
    const t = clean(text);
    if (t.length < 3) return null;
    const existing = await this.list(q, ownerId, scope, MEMORY_PER_SCOPE, now);
    if (existing.some((m) => norm(m.text) === norm(t) || nearlySame(m.text, t))) return null;
    const id = randomUUID();
    await q.query(
      `INSERT INTO memories (id, owner_id, subject_scope, value_enc, provenance, confidence, approved_at, expires_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$7)`,
      [id, ownerId, scope, this.crypto.enc(ownerId, 'memories.value', t), JSON.stringify(prov), opts.confidence ?? 1, now, opts.expiresAt ?? null],
    );
    // retire the oldest beyond the cap (superseded by the new row, so they stop being retrievable)
    const all = await this.list(q, ownerId, scope, MEMORY_PER_SCOPE + 10, now);
    for (const old of all.slice(MEMORY_PER_SCOPE)) await q.query('UPDATE memories SET superseded_by=$1 WHERE id=$2 AND owner_id=$3', [id, old.id, ownerId]);
    return { id, scope, text: t, createdAt: now, source: prov.source };
  }

  /** Newest first. */
  async list(q: Queryable, ownerId: string, scope: string | string[], limit: number, now: Date): Promise<MemoryItem[]> {
    const scopes = Array.isArray(scope) ? scope : [scope];
    const r = await q.query<{ id: string; subject_scope: string; value_enc: string; created_at: Date; provenance: { source?: string } }>(
      `SELECT id, subject_scope, value_enc, created_at, provenance FROM memories
        WHERE owner_id=$1 AND subject_scope = ANY($2) AND approved_at IS NOT NULL AND superseded_by IS NULL AND (expires_at IS NULL OR expires_at > $3)
        ORDER BY created_at DESC, id LIMIT $4`,
      [ownerId, scopes, now, limit],
    );
    return r.rows.map((x) => ({
      id: x.id,
      scope: x.subject_scope,
      text: this.crypto.dec(ownerId, 'memories.value', x.value_enc),
      createdAt: x.created_at,
      source: x.provenance?.source ?? 'unknown',
    }));
  }

  /** Everything the owner can see and delete: owner notes plus every contact's notes, newest first. */
  async listAll(q: Queryable, ownerId: string, limit: number, now: Date): Promise<MemoryItem[]> {
    const r = await q.query<{ subject_scope: string }>(
      `SELECT DISTINCT subject_scope FROM memories WHERE owner_id=$1 AND approved_at IS NOT NULL AND superseded_by IS NULL`,
      [ownerId],
    );
    if (!r.rows.length) return [];
    const items = await this.list(
      q,
      ownerId,
      r.rows.map((x) => x.subject_scope),
      500,
      now,
    );
    return items.slice(0, limit);
  }

  /** Deletes one fact (hard delete: the owner asked to forget it). Returns whether it existed. */
  async forget(q: Queryable, ownerId: string, id: string): Promise<boolean> {
    const r = await q.query('DELETE FROM memories WHERE id=$1 AND owner_id=$2', [id, ownerId]);
    return (r.rowCount ?? 0) > 0;
  }

  /** Forgets every fact about one contact (used when the contact is removed). */
  async forgetContact(q: Queryable, ownerId: string, contactId: string): Promise<number> {
    const r = await q.query('DELETE FROM memories WHERE owner_id=$1 AND subject_scope=$2', [ownerId, contactScope(contactId)]);
    return r.rowCount ?? 0;
  }
}
