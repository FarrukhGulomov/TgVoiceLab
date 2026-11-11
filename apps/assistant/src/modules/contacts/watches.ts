import type { Queryable } from '../../infrastructure/db/db.js';

export const WATCH_TTL_MS = 48 * 3_600_000;

/** "Tell me when this contact replies" — set by the owner, consumed by the first relayed reply when it is a `call` watch. */
export class ContactWatchService {
  async set(q: Queryable, ownerId: string, contactId: string, mode: 'text' | 'call', now: Date): Promise<Date> {
    const expires = new Date(now.getTime() + WATCH_TTL_MS);
    await q.query(`UPDATE contact_watches SET fired_at=$3 WHERE owner_id=$1 AND contact_id=$2 AND fired_at IS NULL`, [ownerId, contactId, now]);
    await q.query(`INSERT INTO contact_watches (owner_id, contact_id, mode, expires_at, created_at) VALUES ($1,$2,$3,$4,$5)`, [
      ownerId,
      contactId,
      mode,
      expires,
      now,
    ]);
    return expires;
  }

  /** The active watch's mode, marking it fired (a watch is used once). */
  async take(q: Queryable, ownerId: string, contactId: string, now: Date): Promise<'text' | 'call' | null> {
    const r = await q.query<{ mode: 'text' | 'call' }>(
      `UPDATE contact_watches SET fired_at=$3 WHERE owner_id=$1 AND contact_id=$2 AND fired_at IS NULL AND expires_at > $3 RETURNING mode`,
      [ownerId, contactId, now],
    );
    return r.rows[0]?.mode ?? null;
  }
}
