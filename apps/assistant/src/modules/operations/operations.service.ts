import type { Db, Queryable } from '../../infrastructure/db/db.js';
import type { Clock } from '../../application/clock.js';
import { writeAudit } from '../audit/audit.js';

/** Registry of live calls so the kill switch / revocation can end media immediately (in-process; the gateway is single-owner). */
export interface ActiveCallControl {
  callId: string;
  ownerId: string;
  contactId: string | null;
  end(reason: 'cancelled' | 'consent_withdrawn' | 'budget_limit' | 'duration_limit'): Promise<void>;
}
export class ActiveCallRegistry {
  private readonly m = new Map<string, ActiveCallControl>();
  add(c: ActiveCallControl) {
    this.m.set(c.callId, c);
  }
  remove(id: string) {
    this.m.delete(id);
  }
  list(ownerId: string) {
    return [...this.m.values()].filter((c) => c.ownerId === ownerId);
  }
}

export class OperationsService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly registry: ActiveCallRegistry,
  ) {}

  /**
   * Persist the kill switch FIRST (so new dials are blocked even if termination below fails), then end live media.
   * Independent of the model. Returns timing for the "stop within 2 s" target.
   */
  async setKillSwitch(ownerId: string, on: boolean, reason: string): Promise<{ on: boolean; terminated: number; elapsedMs: number }> {
    const t0 = performance.now();
    await this.db.tx(async (c) => {
      await c.query(
        `INSERT INTO operation_settings (owner_id, calling_kill_switch, reason, changed_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (owner_id) DO UPDATE SET calling_kill_switch=$2, reason=$3, version=operation_settings.version+1, changed_at=$4`,
        [ownerId, on, reason.slice(0, 200), this.clock.now()],
      );
      if (on)
        await c.query(`UPDATE call_requests SET status='cancelled' WHERE owner_id=$1 AND status IN ('requested','pending_authorization','queued')`, [ownerId]);
      await writeAudit(c, { ownerId, actorType: 'owner', action: on ? 'killswitch.on' : 'killswitch.off', allowed: true, reasonCode: 'ok' });
    });
    let terminated = 0;
    if (on)
      for (const call of this.registry.list(ownerId)) {
        await call.end('cancelled');
        terminated++;
      }
    return { on, terminated, elapsedMs: performance.now() - t0 };
  }

  /** Revocation cancels queued work for the contact and interrupts any live call with them. */
  async onPermissionRevoked(ownerId: string, contactId: string): Promise<{ terminated: number }> {
    await this.db.query(
      `UPDATE call_requests SET status='cancelled' WHERE owner_id=$1 AND contact_id=$2 AND status IN ('requested','pending_authorization','queued')`,
      [ownerId, contactId],
    );
    let terminated = 0;
    for (const call of this.registry.list(ownerId))
      if (call.contactId === contactId) {
        await call.end('consent_withdrawn');
        terminated++;
      }
    return { terminated };
  }

  async isKillSwitchOn(q: Queryable, ownerId: string): Promise<boolean> {
    const r = await q.query<{ calling_kill_switch: boolean }>('SELECT calling_kill_switch FROM operation_settings WHERE owner_id=$1', [ownerId]);
    return r.rows[0]?.calling_kill_switch ?? true; // absent row => fail closed
  }
}

/** Idempotently set today's budget cap (micro-USD). Never lowers below what is already reserved/spent. */
export async function ensureDailyBudget(q: Queryable, ownerId: string, day: string, capMicroUsd: number): Promise<void> {
  await q.query(
    `INSERT INTO usage_budgets (owner_id, day, cap_micro_usd) VALUES ($1,$2,$3)
     ON CONFLICT (owner_id, day) DO UPDATE SET cap_micro_usd = GREATEST($3, usage_budgets.reserved_micro_usd + usage_budgets.actual_micro_usd)`,
    [ownerId, day, capMicroUsd],
  );
}

/** Reserve before connecting. Conservative: the cap is enforced atomically in SQL, so concurrent dials cannot overspend. */
export async function reserveBudget(q: Queryable, ownerId: string, day: string, microUsd: number): Promise<boolean> {
  const r = await q.query(
    `UPDATE usage_budgets SET reserved_micro_usd = reserved_micro_usd + $3
     WHERE owner_id=$1 AND day=$2 AND reserved_micro_usd + actual_micro_usd + $3 <= cap_micro_usd`,
    [ownerId, day, microUsd],
  );
  return r.rowCount === 1;
}
