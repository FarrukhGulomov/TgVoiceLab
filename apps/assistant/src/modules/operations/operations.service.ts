import { inTx, type Db, type Queryable } from '../../infrastructure/db/db.js';
import type { Clock } from '../../application/clock.js';
import { writeAudit } from '../audit/audit.js';
import { DomainError } from '../../application/errors.js';
import { transitionCall } from '../calls/state-machine.js';

/** Registry of live calls so the kill switch / revocation can end media immediately (in-process; the gateway is single-owner). */
export interface ActiveCallControl {
  callId: string;
  ownerId: string;
  contactId: string | null;
  /** The owner called the assistant (not a call the assistant started): the owner's "stop calling me" switch does not end it. */
  inbound?: boolean;
  /** `owner_call` = a call TO the owner (no contact row); `contact_call` = a call to an authorized third party. */
  kind: 'owner_call' | 'contact_call';
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
  all() {
    return [...this.m.values()];
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
    private readonly opts: { retryDelayMs?: number; terminateAttempts?: number } = {},
  ) {}

  /**
   * Persist the kill switch FIRST (so new dials are blocked even if termination below fails), then end live media.
   * Independent of the model. Returns timing for the "stop within 2 s" target.
   */
  async setKillSwitch(ownerId: string, on: boolean, reason: string): Promise<{ on: boolean; terminated: number; elapsedMs: number }> {
    const t0 = performance.now();
    await this.applyKillSwitch(this.db, ownerId, on, reason);
    const terminated = on ? await this.terminateLive(ownerId, undefined, 'cancelled') : 0;
    return { on, terminated, elapsedMs: performance.now() - t0 };
  }

  /** DB part of the kill switch; callable inside a caller's transaction (HTTP idempotency). Live media is ended separately, after commit. */
  async applyKillSwitch(q: Queryable, ownerId: string, on: boolean, reason: string): Promise<{ cancelledRequests: number }> {
    return inTx(q, async (c) => {
      await c.query(
        `INSERT INTO operation_settings (owner_id, calling_kill_switch, reason, changed_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (owner_id) DO UPDATE SET calling_kill_switch=$2, reason=$3, version=operation_settings.version+1, changed_at=$4`,
        [ownerId, on, reason.slice(0, 200), this.clock.now()],
      );
      const cancelledRequests = on ? await this.cancelDialIntents(c, ownerId) : 0;
      await writeAudit(c, { ownerId, actorType: 'owner', action: on ? 'killswitch.on' : 'killswitch.off', allowed: true, reasonCode: 'ok' });
      return { cancelledRequests };
    });
  }

  /**
   * Durably invalidate dispatch intents (audit F12): the request becomes `cancelled`, its authorization `revoked` (so it can never
   * be reused, even after the kill switch is lifted or permissions are re-granted) and any not-yet-claimed `call.dial` job is cancelled.
   * A job already leased is neutralised by the dial path itself, which refuses a request that is not `queued`.
   */
  async cancelDialIntents(q: Queryable, ownerId: string, contactId?: string, ownerCallsOnly = false): Promise<number> {
    const r = await q.query<{ id: string; authorization_id: string | null }>(
      `UPDATE call_requests SET status='cancelled'
       WHERE owner_id=$1 AND ($2::uuid IS NULL OR contact_id=$2) AND ($3::boolean IS NOT TRUE OR contact_id IS NULL)
         AND status IN ('requested','pending_authorization','queued')
       RETURNING id, authorization_id`,
      [ownerId, contactId ?? null, ownerCallsOnly],
    );
    const authIds = r.rows.map((x) => x.authorization_id).filter((x): x is string => !!x);
    if (authIds.length)
      await q.query(`UPDATE authorizations SET state='revoked' WHERE owner_id=$1 AND id = ANY($2::uuid[]) AND state IN ('pending','approved')`, [
        ownerId,
        authIds,
      ]);
    if (r.rows.length)
      await q.query(`UPDATE jobs SET status='cancelled' WHERE kind='call.dial' AND status='pending' AND dedupe_key = ANY($1::text[])`, [
        r.rows.map((x) => `dial:${x.id}`),
      ]);
    return r.rows.length;
  }

  /** Ends one live call, retrying a few times; throws the last error when every attempt failed. */
  private async endWithRetry(call: ActiveCallControl, reason: 'cancelled' | 'consent_withdrawn'): Promise<void> {
    const attempts = this.opts.terminateAttempts ?? 3;
    const delay = this.opts.retryDelayMs ?? 150;
    for (let n = 1; ; n++) {
      try {
        await call.end(reason);
        return;
      } catch (e) {
        if (n >= attempts) throw e;
        await new Promise((r) => setTimeout(r, delay * n));
      }
    }
  }

  /** The owner cancelled ONE call (`/v1/calls/:id/cancel`): retried like every other safety hangup. */
  async terminateCall(ownerId: string, callId: string, reason: 'cancelled' | 'consent_withdrawn'): Promise<boolean> {
    const call = this.registry.list(ownerId).find((c) => c.callId === callId);
    if (!call) return false;
    await this.endWithRetry(call, reason);
    return true;
  }

  /**
   * End live media (in-process). Runs AFTER the database change committed, never inside a transaction. Every matching call is tried even
   * when an earlier one fails, each is retried a few times, and failures are reported at the end (the policy sweep below keeps trying).
   */
  async terminateLive(
    ownerId: string,
    contactId: string | undefined,
    reason: 'cancelled' | 'consent_withdrawn',
    kind?: 'owner_call' | 'contact_call',
  ): Promise<number> {
    let terminated = 0;
    const failures: unknown[] = [];
    for (const call of this.registry.list(ownerId)) {
      if ((contactId && call.contactId !== contactId) || (kind && call.kind !== kind)) continue;
      try {
        await this.endWithRetry(call, reason);
        terminated++;
      } catch (e) {
        failures.push(e);
      }
    }
    if (failures.length) throw new AggregateError(failures, `could not end ${failures.length} live call(s); the policy sweep keeps trying`);
    return terminated;
  }

  /**
   * Convergence of live calls to the DURABLE policy. A kill switch, opt-out or revoked permission is committed first and live media is ended
   * after it; if that hangup failed (or its result was lost), this sweep reads the committed state again and ends every live call it forbids.
   * Run periodically and after any failed termination. Returns how many calls it ended.
   */
  async enforceLivePolicy(ownerId: string): Promise<number> {
    const live = this.registry.list(ownerId);
    if (!live.length) return 0;
    const now = this.clock.now();
    const killSwitch = (await this.db.query<{ calling_kill_switch: boolean }>('SELECT calling_kill_switch FROM operation_settings WHERE owner_id=$1', [ownerId]))
      .rows[0]?.calling_kill_switch;
    const optOut = (await this.db.query<{ call_opt_out: boolean }>('SELECT call_opt_out FROM owners WHERE id=$1', [ownerId])).rows[0]?.call_opt_out ?? false;
    let ended = 0;
    for (const call of live) {
      let reason: 'cancelled' | 'consent_withdrawn' | null = null;
      if (killSwitch === true) reason = 'cancelled';
      else if (optOut && !call.inbound) reason = 'cancelled';
      else if (call.kind === 'contact_call' && call.contactId) {
        const p = (
          await this.db.query<{ allow_call: boolean; expires_at: Date; revoked_at: Date | null }>(
            'SELECT allow_call, expires_at, revoked_at FROM contact_permissions WHERE contact_id=$1 AND owner_id=$2 ORDER BY version DESC LIMIT 1',
            [call.contactId, ownerId],
          )
        ).rows[0];
        if (!p || !p.allow_call || p.expires_at.getTime() <= now.getTime() || (p.revoked_at && p.revoked_at.getTime() <= now.getTime())) reason = 'consent_withdrawn';
      }
      if (!reason) continue;
      try {
        await call.end(reason);
        ended++;
      } catch {
        /* the next sweep tries again */
      }
    }
    return ended;
  }

  /** Owner opt-out ("stop calling me") scope: EVERY call the assistant would place. DB part (callable in the caller's transaction)... */
  async cancelAllCallIntents(q: Queryable, ownerId: string): Promise<number> {
    return this.cancelDialIntents(q, ownerId);
  }

  /** Cancel the queued calls to ONE contact (revoked authorizations, cancelled dial jobs). Callable inside the caller's transaction. */
  async cancelContactCallIntents(q: Queryable, ownerId: string, contactId: string): Promise<number> {
    return this.cancelDialIntents(q, ownerId, contactId);
  }

  /** ...and end that contact's live calls, after commit. */
  terminateLiveContactCalls(ownerId: string, contactId: string): Promise<number> {
    return this.terminateLive(ownerId, contactId, 'cancelled');
  }

  /** ...and the live part, which runs after commit. */
  terminateAllLiveCalls(ownerId: string): Promise<number> {
    return this.terminateLive(ownerId, undefined, 'cancelled');
  }

  /**
   * An outcome_unknown call occupies the account because it might be live. Only an operator who has CHECKED the real phone/account
   * may clear it; clearing settles its budget reservation exactly once.
   */
  async resolveUnknownCall(ownerId: string, callId: string, o: { note: string; now: Date; requestId?: string }, q: Queryable = this.db): Promise<void> {
    await inTx(q, async (c) => {
      const cur = await c.query<{ state: string }>('SELECT state FROM calls WHERE id=$1 AND owner_id=$2 FOR UPDATE', [callId, ownerId]);
      if (!cur.rows[0]) throw new DomainError('not_found', 'call not found');
      if (cur.rows[0].state !== 'outcome_unknown') throw new DomainError('invalid_state', `call is ${cur.rows[0].state}, not outcome_unknown`);
      await transitionCall(c, ownerId, callId, 'ended', { endReason: 'outcome_unknown', now: o.now });
      await settleCallBudget(c, ownerId, callId, 0, o.now);
      await writeAudit(c, {
        ownerId,
        actorType: 'admin_api',
        action: 'call.resolve_unknown',
        resourceType: 'call',
        resourceId: callId,
        allowed: true,
        reasonCode: 'operator_confirmed_no_live_call',
        ...(o.requestId ? { correlationId: o.requestId } : {}),
        metadata: { noteLength: o.note.length },
      });
    });
  }

  /** Calls whose outcome is unknown (they occupy the calling account). */
  async listUnknownCalls(q: Queryable, ownerId: string): Promise<string[]> {
    return (await q.query<{ id: string }>(`SELECT id FROM calls WHERE owner_id=$1 AND state='outcome_unknown' ORDER BY created_at`, [ownerId])).rows.map(
      (x) => x.id,
    );
  }

  /** Calls in any other non-terminal state (what the owner should look at before clearing). */
  async listOpenCallStates(q: Queryable, ownerId: string): Promise<string[]> {
    return (
      await q.query<{ state: string }>(
        `SELECT state FROM calls WHERE owner_id=$1 AND state NOT IN ('outcome_unknown','ended','rejected','cancelled','expired','declined','busy','no_answer','failed','consent_denied')`,
        [ownerId],
      )
    ).rows.map((x) => x.state);
  }

  /** The owner confirmed in chat that no real call is live: clear every outcome_unknown call. Returns how many. */
  async resolveAllUnknownCalls(q: Queryable, ownerId: string, now: Date): Promise<number> {
    const ids = await this.listUnknownCalls(q, ownerId);
    for (const id of ids) await this.resolveUnknownCall(ownerId, id, { note: 'owner confirmed in chat that no call is live', now }, q);
    return ids.length;
  }

  /** Revocation cancels queued work for the contact and interrupts any live call with them. */
  async onPermissionRevoked(ownerId: string, contactId: string, q: Queryable = this.db): Promise<{ terminated: number }> {
    await inTx(q, (c) => this.cancelDialIntents(c, ownerId, contactId));
    return { terminated: await this.terminateLive(ownerId, contactId, 'consent_withdrawn') };
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

/**
 * Settle a call's budget reservation exactly once (audit F13). The reservation is read from the call row (the day and amount it
 * actually reserved), so recovery after midnight or a retry cannot release the wrong day or release twice. `actualMicroUsd` is
 * clamped so reserved + actual never exceeds the day's cap (the cap is a hard ceiling; real overspend is kept in `calls.usage`).
 * Returns false when there was nothing to settle (already settled, or the call never reserved).
 */
export async function settleCallBudget(q: Queryable, ownerId: string, callId: string, actualMicroUsd: number, now: Date): Promise<boolean> {
  const claimed = await q.query<{ budget_day: string; budget_reserved_micro: string }>(
    `UPDATE calls SET budget_settled_at=$3, usage = usage || jsonb_build_object('actualMicroUsd', $4::bigint)
     WHERE id=$1 AND owner_id=$2 AND budget_settled_at IS NULL AND budget_day IS NOT NULL
     RETURNING budget_day::text, budget_reserved_micro::text`,
    [callId, ownerId, now, Math.max(0, Math.round(actualMicroUsd))],
  );
  const row = claimed.rows[0];
  if (!row) return false;
  await q.query(
    `UPDATE usage_budgets SET
       reserved_micro_usd = GREATEST(0, reserved_micro_usd - $3::bigint),
       actual_micro_usd = actual_micro_usd + GREATEST(0, LEAST($4::bigint, cap_micro_usd - GREATEST(0, reserved_micro_usd - $3::bigint) - actual_micro_usd))
     WHERE owner_id=$1 AND day=$2::date`,
    [ownerId, row.budget_day, row.budget_reserved_micro, Math.max(0, Math.round(actualMicroUsd))],
  );
  return true;
}
