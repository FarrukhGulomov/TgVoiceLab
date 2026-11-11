import type { Queryable } from '../db/db.js';

/** One entry of a chat's history, newest-first paging. Only what recovery needs; the gateway keeps the raw message in a closure. */
export interface HistoryMessage {
  id: number;
  out: boolean;
  dateMs: number;
}
export interface HistorySource<M extends HistoryMessage = HistoryMessage> {
  /** Messages with id < offsetId (offsetId 0 = from the newest), newest first, at most `limit`. */
  fetchPage(offsetId: number, limit: number): Promise<M[]>;
}
export interface WatermarkStore {
  get(accountId: string, chatId: string): Promise<number>;
  set(accountId: string, chatId: string, messageId: number): Promise<void>;
}

/** Durable per-chat watermark: the highest message id such that everything at or below it is handled or deliberately skipped. */
export class DbWatermarkStore implements WatermarkStore {
  constructor(
    private readonly db: Queryable,
    private readonly now: () => Date,
  ) {}
  async get(accountId: string, chatId: string): Promise<number> {
    const r = await this.db.query<{ last_message_id: string }>('SELECT last_message_id FROM recovery_watermarks WHERE account_id=$1 AND chat_id=$2', [
      accountId,
      chatId,
    ]);
    return r.rows[0] ? Number(r.rows[0].last_message_id) : 0;
  }
  async set(accountId: string, chatId: string, messageId: number): Promise<void> {
    await this.db.query(
      `INSERT INTO recovery_watermarks (account_id, chat_id, last_message_id, updated_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (account_id, chat_id) DO UPDATE SET last_message_id = GREATEST(recovery_watermarks.last_message_id, EXCLUDED.last_message_id), updated_at = EXCLUDED.updated_at`,
      [accountId, chatId, messageId, this.now()],
    );
  }
}

export interface RecoveryResult {
  complete: boolean;
  handled: number;
  watermark: number;
  reason?: 'page_cap' | 'handler_failed' | 'source_failed';
}
export type RecoveryStatus = { recovery: 'unknown' | 'complete' | 'incomplete'; lastRunAt: string | null; lastError: string | null; watermark: number };

/**
 * Restart / gap recovery for one chat (audit F15). It pages back from the newest message until it reaches the durable watermark or
 * the age window, then handles the eligible incoming messages in ascending order, advancing the watermark as it goes. Replays are
 * safe because intake dedupes on the Telegram update key. A failure or a hit page cap leaves recovery `incomplete` (visible in
 * readiness) and the next pass resumes from the watermark: no manual restart needed. Instructions older than the window are never
 * executed.
 */
export class RecoveryRunner<M extends HistoryMessage = HistoryMessage> {
  private st: RecoveryStatus = { recovery: 'unknown', lastRunAt: null, lastError: null, watermark: 0 };
  constructor(
    private readonly o: {
      accountId: string;
      chatId: string;
      source: HistorySource<M>;
      store: WatermarkStore;
      handle: (m: M) => Promise<void>;
      clock: () => Date;
      windowMs: number;
      pageSize?: number;
      maxPages?: number;
    },
  ) {}

  status(): RecoveryStatus {
    return { ...this.st };
  }

  async runOnce(): Promise<RecoveryResult> {
    const o = this.o;
    const nowMs = o.clock().getTime();
    const pageSize = o.pageSize ?? 100;
    const maxPages = o.maxPages ?? 50;
    const wm0 = await o.store.get(o.accountId, o.chatId);
    const finish = (r: RecoveryResult, err?: unknown): RecoveryResult => {
      this.st = {
        recovery: r.complete ? 'complete' : 'incomplete',
        lastRunAt: o.clock().toISOString(),
        lastError: err ? (err instanceof Error ? err.message : String(err)).slice(0, 200) : null,
        watermark: r.watermark,
      };
      return r;
    };

    // 1) collect, newest -> oldest, until we reach the watermark, the age window, or the start of history
    const collected: M[] = [];
    let offset = 0;
    let reachedBoundary = false;
    for (let page = 0; page < maxPages && !reachedBoundary; page++) {
      let msgs: M[];
      try {
        msgs = await o.source.fetchPage(offset, pageSize);
      } catch (e) {
        return finish({ complete: false, handled: 0, watermark: wm0, reason: 'source_failed' }, e);
      }
      if (!msgs.length) {
        reachedBoundary = true;
        break;
      }
      for (const m of msgs) {
        if (m.id <= wm0 || nowMs - m.dateMs > o.windowMs) {
          reachedBoundary = true; // ids and time both only decrease from here
          break;
        }
        collected.push(m);
      }
      offset = Math.min(...msgs.map((m) => m.id));
    }
    if (!reachedBoundary) {
      // We stopped because of the cap, not because we caught up. Handling only the newest part would run instructions out of order
      // (older ones are still unseen), so do nothing, keep the watermark, and report degraded until an operator raises the cap.
      return finish({ complete: false, handled: 0, watermark: wm0, reason: 'page_cap' });
    }

    // 2) handle ascending; the watermark only moves over messages that are done (or deliberately skipped)
    const r = await this.handleAscending(collected, wm0);
    if (r.error) return finish({ complete: false, handled: r.handled, watermark: r.watermark, reason: 'handler_failed' }, r.error);
    return finish({ complete: true, handled: r.handled, watermark: r.watermark });
  }

  private async handleAscending(collected: M[], wm0: number): Promise<{ handled: number; watermark: number; error?: unknown }> {
    const o = this.o;
    const asc = [...collected].sort((a, b) => a.id - b.id);
    let handled = 0;
    let wm = wm0;
    for (const m of asc) {
      if (!m.out) {
        try {
          await o.handle(m);
          handled++;
        } catch (e) {
          // Everything strictly below this id is done or skipped; stop here so ordering is preserved and the next pass retries it.
          if (m.id - 1 > wm) {
            wm = m.id - 1;
            await o.store.set(o.accountId, o.chatId, wm);
          }
          return { handled, watermark: wm, error: e };
        }
      }
      if (m.id > wm) {
        wm = m.id;
        await o.store.set(o.accountId, o.chatId, wm);
      }
    }
    return { handled, watermark: wm };
  }
}
