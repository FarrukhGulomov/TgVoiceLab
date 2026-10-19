import type { DataCrypto } from '../../infrastructure/crypto/data-crypto.js';
import type { Queryable } from '../../infrastructure/db/db.js';
import { LESSON_SCOPE, OWNER_SCOPE, contactScope, type MemoryService } from './memory.service.js';

/** How many of the question's words (compared by their first letters, so "Onixni" meets "Onix") occur in a stored text. */
export function relevance(stored: string, question: string): number {
  const stems = (x: string) => new Set((x.toLowerCase().match(/[\p{L}\p{N}']{4,}/gu) ?? []).map((w) => w.replace(/'/g, '').slice(0, 4)));
  const have = stems(stored);
  let n = 0;
  for (const w of stems(question)) if (have.has(w)) n++;
  return n;
}

export interface Recalled {
  /** Call reports, best match (or newest) first, e.g. "Test2 (counter_offer, 2026-10-18T10:41Z): ...". */
  calls: string[];
  /** The owner's notes and what was learnt about contacts, e.g. "Test2: ...". */
  memories: string[];
}

/**
 * One place that answers "what do I know about this?" for every channel (text, voice note, live call): call reports of the last 30 days
 * and all notes, ranked by how well they match the question. An empty question returns the most recent material.
 */
export class RecallService {
  constructor(
    private readonly crypto: DataCrypto,
    private readonly memory: MemoryService,
  ) {}

  async recall(q: Queryable, ownerId: string, question: string, now: Date, o: { calls?: number; memories?: number } = {}): Promise<Recalled> {
    const names = new Map(
      (await q.query<{ id: string; display_name: string }>('SELECT id, display_name FROM contacts WHERE owner_id=$1', [ownerId])).rows.map((x) => [
        x.id,
        x.display_name,
      ]),
    );
    const low = question.toLowerCase();
    const rows = (
      await q.query<{ narrative_enc: string | null; display_name: string; outcome: string; created_at: Date }>(
        `SELECT rp.narrative_enc, c.display_name, rp.structured_result->>'outcome' AS outcome, rp.created_at
           FROM call_reports rp JOIN calls k ON k.id=rp.call_id JOIN call_requests rq ON rq.id=k.call_request_id JOIN contacts c ON c.id=rq.contact_id
          WHERE rp.owner_id=$1 AND rp.complete AND rp.created_at > $2 ORDER BY rp.created_at DESC LIMIT 40`,
        [ownerId, new Date(now.getTime() - 30 * 86_400_000)],
      )
    ).rows.map((x, i) => {
      const body = x.narrative_enc ? this.crypto.dec(ownerId, 'call_reports.narrative', x.narrative_enc).replace(/\s+/g, ' ') : '';
      return { x, i, body, score: relevance(body, question) + (low.includes(x.display_name.toLowerCase()) ? 3 : 0) };
    });
    const calls = rows
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .slice(0, o.calls ?? 12)
      .map(
        ({ x, body, score }, k) =>
          `${x.display_name} (${x.outcome}, ${x.created_at.toISOString().slice(0, 16)}Z): ${body.slice(0, score > 0 || k < 3 ? 1200 : 300)}`,
      );

    const scopes = [OWNER_SCOPE, LESSON_SCOPE, ...[...names.keys()].map(contactScope)];
    const named = new Set([...names].filter(([, n]) => low.includes(n.toLowerCase())).map(([id]) => contactScope(id)));
    const items = await this.memory.list(q, ownerId, scopes, 80, now);
    const memories = items
      .map((m, i) => ({ m, i, score: relevance(m.text, question) + (named.has(m.scope) ? 2 : 0) + (m.scope === OWNER_SCOPE ? 0.5 : 0) }))
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .slice(0, o.memories ?? 25)
      .map(({ m }) => {
        const id = /^contact:([0-9a-f-]{36}):notes$/.exec(m.scope)?.[1];
        const who = id ? names.get(id) : undefined;
        return who ? `${who}: ${m.text}` : m.text;
      });
    return { calls, memories };
  }
}
