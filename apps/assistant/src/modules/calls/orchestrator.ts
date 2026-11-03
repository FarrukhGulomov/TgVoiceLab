import {
  DialOutcomeUnknownError,
  DialRejectedError,
  type ApprovedCallPlan,
  type CallEndReason,
  type CallEvent,
  type CallHandle,
  type TelegramCallAdapter,
} from '@tgvl/contracts';
import { DateTime } from 'luxon';
import type { Db, Queryable } from '../../infrastructure/db/db.js';
import type { Clock } from '../../application/clock.js';
import { writeAudit } from '../audit/audit.js';
import { emitOutbox } from '../outbox/outbox.js';
import { evaluateDialPolicy, type DialPolicyInput } from '../policy/dial-policy.js';
import { ActiveCallRegistry, ensureDailyBudget, reserveBudget, settleCallBudget } from '../operations/operations.service.js';
import { withTimeout } from '../../application/async.js';
import type { DerivedCapabilities } from './capability-evidence.js';
import { transitionCall, TERMINAL, type CallState } from './state-machine.js';
import type { DataCrypto } from '../../infrastructure/crypto/data-crypto.js';
import { openPlan, PlanIntegrityError } from './plan-store.js';

/**
 * Conversation layer port (Phase 3/4: media bridge, Realtime, consent gate, tools). NOT IMPLEMENTED: those phases are
 * blocked behind the Phase 0 gates. The default runner ends the call immediately, so no unverified conversational path exists.
 */
export interface CallSessionRunner {
  run(ctx: { callId: string; ownerId: string; plan: ApprovedCallPlan; handle: CallHandle }): Promise<{
    endReason: CallEndReason;
    usageMicroUsd?: number;
    /** Contact calls: what the AI reports back to the owner (the narrative is stored sealed). */
    report?: { outcome: string; summary: string };
    /** Did the other person actually take part (proven by what the recogniser heard, not by line noise)? Reports must not claim otherwise. */
    conversationHeld?: boolean;
  }>;
}
export const noSessionRunner: CallSessionRunner = { run: async () => ({ endReason: 'cancelled', usageMicroUsd: 0, conversationHeld: false }) };

export type DialOutcome =
  | { status: 'rejected'; reason: string }
  | { status: 'finished'; callId: string; state: CallState; endReason: CallEndReason | null }
  | { status: 'outcome_unknown'; callId: string };

export interface OrchestratorDeps {
  db: Db;
  crypto: DataCrypto;
  clock: Clock;
  adapter: TelegramCallAdapter;
  derive: () => DerivedCapabilities;
  registry: ActiveCallRegistry;
  sessionRunner?: CallSessionRunner;
  /** Reserved against the daily cap before connecting (micro-USD). */
  callBudgetMicroUsd: number;
  /** CALLS_ENABLED. Fail closed: when false no call is ever dialed, whatever the evidence says. */
  callsEnabled: boolean;
  /** Daily cap (micro-USD). When set, each local day's budget row is created lazily and atomically before the first reservation. */
  dailyCapMicroUsd?: number;
  ringTimeoutMs?: number;
  /**
   * Bounded waits (audit F04). `dialMs`: the adapter must return a handle or fail; `eventIdleMs`: a live call's event stream must
   * show life (adapters emit a `heartbeat` at least every 30 s); `hangupMs`: ending the call and asking the provider must finish.
   */
  timeouts?: { dialMs?: number; eventIdleMs?: number; hangupMs?: number; runnerMs?: number };
}

class PolicyDenied extends Error {
  constructor(readonly reason: string) {
    super(`policy denied: ${reason}`);
  }
}

const REASON_TO_STATE: Partial<Record<CallEndReason, CallState>> = { declined: 'declined', busy: 'busy', no_answer: 'no_answer' };

export class CallOrchestrator {
  private readonly runner: CallSessionRunner;
  private readonly tm: { dialMs: number; eventIdleMs: number; hangupMs: number; runnerMs: number };
  constructor(private readonly d: OrchestratorDeps) {
    this.runner = d.sessionRunner ?? noSessionRunner;
    this.tm = {
      dialMs: d.timeouts?.dialMs ?? 45_000,
      eventIdleMs: d.timeouts?.eventIdleMs ?? 90_000,
      hangupMs: d.timeouts?.hangupMs ?? 10_000,
      runnerMs: d.timeouts?.runnerMs ?? 20_000,
    };
  }

  private dayKey(tz: string): string {
    return DateTime.fromJSDate(this.d.clock.now(), { zone: tz }).toFormat('yyyy-LL-dd');
  }

  /** Gather every fact the pure policy needs. `excludeCallId` lets the re-check ignore the row we just inserted. */
  async loadInput(
    q: Queryable,
    ownerId: string,
    callRequestId: string,
    o: { budgetReserved: boolean; excludeCallId?: string; inbound?: boolean },
  ): Promise<DialPolicyInput | null> {
    const req = await q.query<{ plan: unknown; plan_enc: string | null; authorization_id: string; contact_id: string; status: string }>(
      'SELECT plan, plan_enc, authorization_id, contact_id, status FROM call_requests WHERE id=$1 AND owner_id=$2',
      [callRequestId, ownerId],
    );
    if (!req.rows[0]) return null;
    let plan: ApprovedCallPlan;
    try {
      plan = openPlan(this.d.crypto, ownerId, req.rows[0].plan, req.rows[0].plan_enc);
    } catch (e) {
      if (e instanceof PlanIntegrityError) throw new PolicyDenied('plan_hash_mismatch'); // tampered storage is a hash mismatch: no dial
      throw e;
    }
    // One connection runs one query at a time: issue these in order (pg deprecates overlapping queries on a client) instead of racing them.
    let tail: Promise<unknown> = Promise.resolve();
    const s = {
      query: ((...args: unknown[]) => {
        const run = tail.then(() => (q.query as (...a: unknown[]) => Promise<unknown>)(...args));
        tail = run.catch(() => undefined);
        return run;
      }) as typeof q.query,
    };
    const [own, auth, contact, perm, ks, acct] = await Promise.all([
      s.query<{
        id: string;
        telegram_user_id: string;
        disabled: boolean;
        timezone: string;
        quiet_hours: DialPolicyInput['owner']['quietHours'];
        call_opt_out: boolean;
        policy_version: number;
      }>('SELECT id, telegram_user_id, disabled, timezone, quiet_hours, call_opt_out, policy_version FROM owners WHERE id=$1', [ownerId]),
      s.query<{ id: string; owner_id: string; state: string; expires_at: Date; plan_hash: string }>(
        'SELECT id, owner_id, state, expires_at, plan_hash FROM authorizations WHERE id=$1',
        [req.rows[0].authorization_id],
      ),
      s.query<{
        id: string;
        telegram_user_id: string;
        verified_at: Date | null;
        timezone: string | null;
        ai_consent_attested_at: Date | null;
        ai_consent_revoked_at: Date | null;
      }>('SELECT id, telegram_user_id, verified_at, timezone, ai_consent_attested_at, ai_consent_revoked_at FROM contacts WHERE id=$1 AND owner_id=$2', [
        req.rows[0].contact_id,
        ownerId,
      ]),
      s.query<{
        version: number;
        allow_call: boolean;
        topic_scopes: string[];
        allowed_hours: { start: string; end: string } | null;
        expires_at: Date;
        revoked_at: Date | null;
      }>(
        'SELECT version, allow_call, topic_scopes, allowed_hours, expires_at, revoked_at FROM contact_permissions WHERE contact_id=$1 AND owner_id=$2 ORDER BY version DESC LIMIT 1',
        [req.rows[0].contact_id, ownerId],
      ),
      s.query<{ calling_kill_switch: boolean }>('SELECT calling_kill_switch FROM operation_settings WHERE owner_id=$1', [ownerId]),
      s.query<{ id: string; status: string }>(`SELECT id, status FROM telegram_accounts WHERE owner_id=$1 ORDER BY created_at LIMIT 1`, [ownerId]),
    ]);
    const o0 = own.rows[0];
    if (!o0) return null;
    const active = acct.rows[0]
      ? await q.query(
          "SELECT 1 FROM calls WHERE account_id=$1 AND state NOT IN ('ended','rejected','cancelled','expired','declined','busy','no_answer','failed','consent_denied') AND ($2::uuid IS NULL OR id <> $2) LIMIT 1",
          [acct.rows[0].id, o.excludeCallId ?? null],
        )
      : { rowCount: 0 };
    const caps = this.d.derive();
    const a = auth.rows[0];
    const c = contact.rows[0];
    const p = perm.rows[0];
    return {
      now: this.d.clock.now(),
      // A call addressed to the owner's own numeric id is an owner call (opt-out and quiet hours apply); everything else is a contact call.
      kind: plan.recipientTelegramId === o0.telegram_user_id ? 'owner_call' : 'contact_call',
      policyVersion: o0.policy_version,
      owner: { id: o0.id, disabled: o0.disabled, timezone: o0.timezone, quietHours: o0.quiet_hours, callOptOut: o0.call_opt_out, verified: true },
      plan,
      requestStatus: req.rows[0].status,
      callingEnabled: this.d.callsEnabled,
      authorization: a ? { id: a.id, ownerId: a.owner_id, state: a.state, expiresAt: a.expires_at, planHash: a.plan_hash } : null,
      contact: c
        ? {
            id: c.id,
            telegramUserId: c.telegram_user_id,
            verifiedAt: c.verified_at,
            timezone: c.timezone,
            aiConsentAttestedAt: c.ai_consent_attested_at,
            aiConsentRevokedAt: c.ai_consent_revoked_at,
          }
        : null,
      permission: p
        ? {
            version: p.version,
            allowCall: p.allow_call,
            topicScopes: p.topic_scopes,
            allowedHours: p.allowed_hours,
            expiresAt: p.expires_at,
            revokedAt: p.revoked_at,
          }
        : null,
      capability: {
        privateOutbound: caps.privateOutbound,
        pcmSend: caps.pcmSend,
        pcmReceive: caps.pcmReceive,
        productionCallingAllowed: caps.productionCallingAllowed,
        ownerCallingAllowed: caps.ownerCallingAllowed,
        thirdPartyConsentMechanismProven: caps.thirdPartyConsentMechanismProven,
        // deriveCapabilities() yields evidenceArtifact=null whenever evidence is missing/invalid/bound to a different build.
        buildFingerprintMatches: caps.evidenceArtifact !== null,
      },
      accountHealthy: acct.rows[0]?.status === 'active',
      killSwitchOn: ks.rows[0]?.calling_kill_switch ?? true,
      activeCallExists: !!active.rowCount,
      budgetReserved: o.budgetReserved,
      ...(o.inbound ? { inbound: true } : {}),
    };
  }

  private async reject(ownerId: string, callRequestId: string, reason: string, quiet = false): Promise<DialOutcome> {
    const now = this.d.clock.now();
    await this.d.db.tx(async (c) => {
      // A dial attempt before the owner approved must not kill the request: it stays pending and approval makes it dialable.
      await c.query(
        `UPDATE call_requests SET status='rejected'
         WHERE id=$1 AND owner_id=$2 AND status IN ('requested','pending_authorization','queued','preflight')
           AND NOT (status='pending_authorization' AND $3 = 'authorization_not_approved')`,
        [callRequestId, ownerId, reason],
      );
      await writeAudit(c, {
        ownerId,
        actorType: 'system',
        action: 'call.dial',
        resourceType: 'call_request',
        resourceId: callRequestId,
        allowed: false,
        reasonCode: reason,
      });
      // The owner ringing again while their first call is still up needs no "refused" message: they are on that call.
      if (!quiet)
        await emitOutbox(
          c,
          { ownerId, aggregateType: 'call_request', aggregateId: callRequestId, type: 'call.notify', payload: { variant: 'rejected', reason } },
          now,
        );
    });
    return { status: 'rejected', reason };
  }

  /** `inbound`: the owner is calling the assistant and the adapter answers it (the adapter's `dial` takes the ring instead of placing a call). */
  async dial(ownerId: string, callRequestId: string, opts: { inbound?: boolean } = {}): Promise<DialOutcome> {
    const { db, clock } = this.d;
    // Pass 1 (read-only, no side effects): fail fast.
    let pre: DialPolicyInput | null;
    try {
      pre = await this.loadInput(db, ownerId, callRequestId, { budgetReserved: true, ...(opts.inbound ? { inbound: true } : {}) });
    } catch (e) {
      if (e instanceof PolicyDenied) return this.reject(ownerId, callRequestId, e.reason);
      throw e;
    }
    if (!pre) return this.reject(ownerId, callRequestId, 'call_request_not_found');
    const first = evaluateDialPolicy(pre);
    if (!first.allowed) return this.reject(ownerId, callRequestId, first.reasonCode, !!opts.inbound && first.reasonCode === 'active_call_exists');
    const plan = pre.plan;
    const day = this.dayKey(pre.owner.timezone);
    const contactId = pre.contact?.id ?? null;
    const kind = pre.kind;
    const ac = new AbortController();
    let registered: string | null = null;

    // Pass 2: take the call row (the "lease"), consume the single-use authorization, reserve budget, and RE-EVALUATE with
    // fresh data inside the same transaction. Any denial rolls everything back — nothing is consumed by a refused dial.
    let callId: string;
    try {
      callId = await db.tx(async (c) => {
        await c.query('SELECT 1 FROM operation_settings WHERE owner_id=$1 FOR SHARE', [ownerId]);
        // Serialises with the owner opt-out (which updates this row): an opt-out that commits first is seen by the re-evaluation
        // below; one that waits for us finds this call already registered (see `registry.add` before commit).
        await c.query('SELECT 1 FROM owners WHERE id=$1 FOR SHARE', [ownerId]);
        // Serialize on the authorization so two dials cannot both pass the check; it stays 'approved' until after re-evaluation.
        await c.query('SELECT 1 FROM authorizations WHERE id=$1 AND owner_id=$2 FOR UPDATE', [plan.authorizationId, ownerId]);
        const acct = await c.query<{ id: string; gateway_generation: string }>(
          'SELECT id, gateway_generation FROM telegram_accounts WHERE owner_id=$1 ORDER BY created_at LIMIT 1',
          [ownerId],
        );
        const attempt = (await c.query<{ n: number }>('SELECT coalesce(max(attempt),0)+1 AS n FROM calls WHERE call_request_id=$1', [callRequestId])).rows[0]!
          .n;
        const ins = await c.query<{ id: string }>(
          `INSERT INTO calls (owner_id, call_request_id, account_id, attempt, authorization_id, gateway_generation, state, started_at)
           VALUES ($1,$2,$3,$4,$5,$6,'preflight',$7) RETURNING id`,
          [ownerId, callRequestId, acct.rows[0]!.id, attempt, plan.authorizationId, acct.rows[0]!.gateway_generation, clock.now()],
        );
        const id = ins.rows[0]!.id;
        // Each local day's budget row is created on demand (audit F13); the reservation is recorded ON the call.
        if (this.d.dailyCapMicroUsd) await ensureDailyBudget(c, ownerId, day, this.d.dailyCapMicroUsd);
        const reserved = await reserveBudget(c, ownerId, day, this.d.callBudgetMicroUsd);
        if (reserved) await c.query('UPDATE calls SET budget_day=$2::date, budget_reserved_micro=$3 WHERE id=$1', [id, day, this.d.callBudgetMicroUsd]);
        // Re-evaluate EVERY check with fresh data, after taking the call row and before the external side effect.
        const fresh = await this.loadInput(c, ownerId, callRequestId, {
          budgetReserved: reserved,
          excludeCallId: id,
          ...(opts.inbound ? { inbound: true } : {}),
        });
        const second = evaluateDialPolicy(fresh!);
        if (!second.allowed) throw new PolicyDenied(second.reasonCode);
        const consumed = await c.query(`UPDATE authorizations SET state='consumed', consumed_at=$2 WHERE id=$1 AND owner_id=$3 AND state='approved'`, [
          plan.authorizationId,
          clock.now(),
          ownerId,
        ]);
        if (consumed.rowCount !== 1) throw new PolicyDenied('authorization_not_approved');
        await transitionCall(c, ownerId, id, 'dialing', { now: clock.now() });
        await c.query(`UPDATE call_requests SET status='dialing' WHERE id=$1`, [callRequestId]);
        await writeAudit(c, {
          ownerId,
          actorType: 'system',
          action: 'call.dial',
          resourceType: 'call',
          resourceId: id,
          allowed: true,
          reasonCode: 'ok',
          metadata: { callRequestId, attempt, planHash: plan.planHash, kind },
        });
        // Registered BEFORE commit so a kill switch / opt-out that is waiting on our locks always finds this call (no handover gap).
        this.d.registry.add({ callId: id, ownerId, contactId, kind, ...(opts.inbound ? { inbound: true } : {}), end: async () => ac.abort() });
        registered = id;
        return id;
      });
    } catch (e) {
      if (registered) this.d.registry.remove(registered);
      if (e instanceof PolicyDenied) return this.reject(ownerId, callRequestId, e.reason, !!opts.inbound && e.reason === 'active_call_exists');
      if ((e as { code?: string }).code === '23505' && String((e as { constraint?: string }).constraint).includes('calls_one_active_per_account'))
        return this.reject(ownerId, callRequestId, 'active_call_exists', !!opts.inbound);
      throw e;
    }

    // ---- external side effect: the intent is already durable ------------------------------------------------------
    // The dial itself is bounded: an adapter that never returns is aborted at the deadline and the outcome is treated as unknown.
    const dialTimer = setTimeout(() => ac.abort(), this.tm.dialMs);
    let handle: CallHandle;
    try {
      handle = await this.d.adapter.dial(plan, ac.signal);
    } catch (e) {
      clearTimeout(dialTimer);
      this.d.registry.remove(callId);
      return this.onDialError(ownerId, callRequestId, callId, e);
    }
    clearTimeout(dialTimer);
    // A stop requested during the dial (kill switch, opt-out, revocation, deadline) must not vanish in the handover.
    return this.supervise(ownerId, callRequestId, callId, plan, handle, contactId, kind, ac.signal.aborted, !!opts.inbound);
  }

  /** Dial failed. Distinguish "definitely not placed" from "may have been placed"; never redial in either case. */
  private async onDialError(ownerId: string, callRequestId: string, callId: string, e: unknown): Promise<DialOutcome> {
    const now = this.d.clock.now();
    if (e instanceof DialRejectedError) {
      const state: CallState = REASON_TO_STATE[e.reason] ?? 'failed';
      await this.d.db.tx(async (c) => {
        await transitionCall(c, ownerId, callId, state, { endReason: e.reason, now });
        await c.query(`UPDATE call_requests SET status='failed' WHERE id=$1`, [callRequestId]);
        await settleCallBudget(c, ownerId, callId, 0, now); // definitely not placed: nothing was spent
        await emitOutbox(
          c,
          {
            ownerId,
            aggregateType: 'call',
            aggregateId: callId,
            type: 'call.notify',
            payload: { variant: 'ended', reason: e.reason, retryAfterSeconds: e.retryAfterSeconds ?? null },
          },
          now,
        );
        await writeAudit(c, {
          ownerId,
          actorType: 'system',
          action: 'call.dial_result',
          resourceType: 'call',
          resourceId: callId,
          allowed: false,
          reasonCode: e.reason,
        });
      });
      return { status: 'finished', callId, state, endReason: e.reason };
    }
    // Anything else (timeout, transport error, abort, crash) after the request may have been sent => uncertain.
    const providerId = e instanceof DialOutcomeUnknownError ? e.providerCallId : undefined;
    const rec = providerId ? await this.d.adapter.reconcile(providerId).catch(() => 'unknown' as const) : ('unknown' as const);
    if (rec === 'ended') {
      await this.d.db.tx(async (c) => {
        await transitionCall(c, ownerId, callId, 'failed', { endReason: 'transport_error', providerCallId: providerId, now });
        await c.query(`UPDATE call_requests SET status='failed' WHERE id=$1`, [callRequestId]);
        await settleCallBudget(c, ownerId, callId, 0, now);
        await emitOutbox(
          c,
          { ownerId, aggregateType: 'call', aggregateId: callId, type: 'call.notify', payload: { variant: 'ended', reason: 'transport_error' } },
          now,
        );
      });
      return { status: 'finished', callId, state: 'failed', endReason: 'transport_error' };
    }
    // 'active' (we have no handle to control it) or 'unknown': the account stays occupied and the reservation is KEPT until an
    // operator resolves the call.
    await this.persistUnknown(ownerId, callRequestId, callId, 'dial_outcome_unknown', providerId);
    return { status: 'outcome_unknown', callId };
  }

  /** Persist an unproven outcome: the call row becomes outcome_unknown (occupies the account), the reservation stays reserved. */
  private async persistUnknown(ownerId: string, callRequestId: string, callId: string, why: string, providerCallId?: string): Promise<void> {
    const now = this.d.clock.now();
    await this.d.db.tx(async (c) => {
      const cur = (await c.query<{ state: CallState }>('SELECT state FROM calls WHERE id=$1 FOR UPDATE', [callId])).rows[0]?.state;
      if (!cur || TERMINAL.has(cur)) return; // someone (recovery, an operator) already settled it with better knowledge
      await transitionCall(c, ownerId, callId, 'outcome_unknown', { endReason: 'outcome_unknown', providerCallId, now });
      await c.query(`UPDATE call_requests SET status='failed' WHERE id=$1`, [callRequestId]);
      await emitOutbox(c, { ownerId, aggregateType: 'call', aggregateId: callId, type: 'call.notify', payload: { variant: 'outcome_unknown' } }, now);
      await writeAudit(c, {
        ownerId,
        actorType: 'system',
        action: 'call.outcome_unknown',
        resourceType: 'call',
        resourceId: callId,
        allowed: false,
        reasonCode: why,
      });
    });
  }

  /**
   * Consume adapter events with idempotent persistence. Every wait is bounded: the event stream must show life (idle deadline), the
   * whole call has a lifetime deadline, and ending the call is bounded too. If the end of the call cannot be PROVEN (a terminal
   * event, or the provider confirming it is over) the outcome is persisted as outcome_unknown and keeps the account occupied.
   */
  private async supervise(
    ownerId: string,
    callRequestId: string,
    callId: string,
    plan: ApprovedCallPlan,
    handle: CallHandle,
    contactId: string | null,
    kind: 'owner_call' | 'contact_call',
    abortRequested: boolean,
    inbound = false,
  ): Promise<DialOutcome> {
    const { db, clock } = this.d;
    const tm = this.tm;
    let seq = 0;
    let endReason: CallEndReason | null = null;
    let ending = false;
    let providerCallId: string | undefined;
    let terminalSeen = false;
    let usageMicroUsd: number | null = 0; // null = a paid conversation ran and its usage is unknown (settled at the reserved amount, see settleCallBudget)
    let conversationHeld: boolean | undefined;
    let report: { outcome: string; summary: string } | undefined;
    let runnerDone: Promise<unknown> | undefined; // the conversation layer keeps working (memory, follow-ups) after the line is gone
    const endAttempt = async (reason: CallEndReason) => {
      endReason ??= reason;
      await withTimeout(handle.end(reason), tm.hangupMs, 'hangup');
    };
    // Internal use: a failed hangup is not fatal here (the proof is checked after the loop) but must stay retryable, so `ending` is cleared.
    const endOnce = async (reason: CallEndReason) => {
      if (ending) return;
      ending = true;
      try {
        await endAttempt(reason);
      } catch {
        ending = false;
      }
    };
    // For the kill switch / revocation / cancel: a failed hangup is REPORTED to the caller (who retries) and a later attempt really tries again.
    const endChecked = async (reason: CallEndReason) => {
      if (ending) return;
      ending = true;
      try {
        await endAttempt(reason);
      } catch (e) {
        ending = false;
        throw e;
      }
    };
    this.d.registry.add({ callId, ownerId, contactId, kind, ...(inbound ? { inbound: true } : {}), end: (r) => endChecked(r) });
    if (abortRequested) void endOnce('cancelled');

    const ringMs = this.d.ringTimeoutMs ?? 30_000;
    const ringTimer = setTimeout(() => void endOnce('no_answer'), ringMs);
    let durTimer: NodeJS.Timeout | undefined;
    let connected = false;
    const deadline = Date.now() + ringMs + plan.maxDurationSeconds * 1000 + tm.hangupMs + 30_000;

    const record = async (ev: CallEvent): Promise<boolean> => {
      const r = await db.query(
        `INSERT INTO call_events (owner_id, call_id, provider_event_key, event_type, metadata, sequence, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (call_id, provider_event_key) DO NOTHING`,
        [ownerId, callId, ev.eventId, ev.type, JSON.stringify({ reason: ev.reason ?? null }), seq++, ev.occurredAt],
      );
      return r.rowCount === 1; // false => duplicate provider event, already applied
    };

    const it = handle.events[Symbol.asyncIterator]();
    try {
      for (;;) {
        const left = deadline - Date.now();
        if (left <= 0) break; // lifetime deadline: stop waiting, prove the end below
        let step: IteratorResult<CallEvent>;
        try {
          step = await withTimeout(it.next(), Math.min(tm.eventIdleMs, left), 'call event');
        } catch {
          break; // a stream that shows no life is a stalled stream: prove the end below
        }
        if (step.done) break;
        const ev = step.value;
        if (ev.providerCallId) providerCallId = ev.providerCallId;
        if (!(await record(ev))) continue;
        const now = clock.now();
        if (ev.type === 'ringing') await transitionCall(db, ownerId, callId, 'ringing', { providerCallId: ev.providerCallId, now });
        else if (ev.type === 'connected') {
          clearTimeout(ringTimer);
          connected = true;
          await transitionCall(db, ownerId, callId, 'connected', { providerCallId: ev.providerCallId, now });
          durTimer = setTimeout(() => void endOnce('duration_limit'), plan.maxDurationSeconds * 1000);
          // Conversation (consent gate, Realtime, tools) is Phase 3/4. With no runner this ends the call at once.
          runnerDone = this.runner.run({ callId, ownerId, plan, handle }).then(
            (r) => {
              usageMicroUsd = r.usageMicroUsd ?? null;
              report = r.report;
              conversationHeld = r.conversationHeld;
              return endOnce(r.endReason);
            },
            () => {
              usageMicroUsd = null; // the conversation ran (or tried to) and we do not know what it cost
              return endOnce('transport_error');
            },
          );
          void runnerDone.catch(() => undefined);
        } else if (ev.type === 'ended' || ev.type === 'error') {
          terminalSeen = true;
          endReason ??= ev.reason ?? 'transport_error';
          break;
        }
      }
    } catch {
      endReason ??= 'transport_error';
    } finally {
      clearTimeout(ringTimer);
      if (durTimer) clearTimeout(durTimer);
      this.d.registry.remove(callId);
      void Promise.resolve(it.return?.()).catch(() => undefined);
    }

    // Prove the end. Without a terminal event: try to hang up (bounded), then ask the provider.
    let proven = terminalSeen;
    if (!proven) {
      await endOnce(endReason ?? 'transport_error');
      const pid =
        providerCallId ??
        (await db.query<{ provider_call_id: string | null }>('SELECT provider_call_id FROM calls WHERE id=$1', [callId])).rows[0]?.provider_call_id ??
        undefined;
      const rec = pid ? await withTimeout(this.d.adapter.reconcile(pid), tm.hangupMs, 'reconcile').catch(() => 'unknown' as const) : ('unknown' as const);
      proven = rec === 'ended';
    }
    if (!proven) {
      await this.persistUnknown(ownerId, callRequestId, callId, 'end_not_proven', providerCallId);
      return { status: 'outcome_unknown', callId };
    }

    // The other side may hang up first: the conversation layer is still writing its report, usage and follow-ups. Wait for it (bounded)
    // instead of settling the call as "no conversation" with zero cost; if it does not finish, the cost is unknown and the report incomplete.
    if (runnerDone) {
      const settled = await withTimeout(runnerDone, this.tm.runnerMs, 'conversation wrap-up').then(
        () => true,
        () => false,
      );
      if (!settled) {
        usageMicroUsd = null;
        report = undefined;
        conversationHeld = undefined;
      }
    }

    const final = endReason ?? 'transport_error';
    const now = clock.now();
    const cur = (await db.query<{ state: CallState }>('SELECT state FROM calls WHERE id=$1', [callId])).rows[0]!.state;
    const terminalState: CallState = !connected ? (REASON_TO_STATE[final] ?? 'failed') : 'ended';
    await db.tx(async (c) => {
      if (!TERMINAL.has(cur)) {
        if (connected && cur !== 'ending') await transitionCall(c, ownerId, callId, 'ending', { now });
        await transitionCall(c, ownerId, callId, terminalState, { endReason: final, now });
      }
      await c.query(`UPDATE call_requests SET status=$2 WHERE id=$1`, [callRequestId, final === 'completed' ? 'completed' : 'failed']);
      await settleCallBudget(c, ownerId, callId, usageMicroUsd, now);
      if (report) {
        await c.query(
          `INSERT INTO call_reports (call_id, owner_id, status, structured_result, narrative_enc, complete) VALUES ($1,$2,'generated',$3,$4,true) ON CONFLICT (call_id) DO NOTHING`,
          [
            callId,
            ownerId,
            JSON.stringify({ outcome: report.outcome, endReason: final, conversationHeld: conversationHeld ?? true }),
            this.d.crypto.enc(ownerId, 'call_reports.narrative', report.summary),
          ],
        );
        await emitOutbox(
          c,
          { ownerId, aggregateType: 'call', aggregateId: callId, type: 'call.report', payload: { outcome: report.outcome, reason: final } },
          now,
        );
        return;
      }
      // Truthful minimal report: no conversation took place.
      await c.query(
        `INSERT INTO call_reports (call_id, owner_id, status, structured_result, complete) VALUES ($1,$2,'generated',$3,false) ON CONFLICT (call_id) DO NOTHING`,
        [
          callId,
          ownerId,
          JSON.stringify({
            outcome: terminalState,
            endReason: final,
            conversationHeld: conversationHeld ?? false,
            note: conversationHeld ? 'conversation held; no written report for owner calls' : 'no conversation took place',
          }),
        ],
      );
      await emitOutbox(c, { ownerId, aggregateType: 'call', aggregateId: callId, type: 'call.notify', payload: { variant: 'ended', reason: final } }, now);
    });
    return { status: 'finished', callId, state: terminalState, endReason: final };
  }
}

/**
 * Crash recovery (spec §7, A11/A13). After a restart the in-process registry is empty, so any non-terminal call has lost its
 * supervisor. Reconcile with the provider where we have an id. Anything the provider does not CONFIRM as over stays
 * `outcome_unknown` (occupying the account, reservation kept) for every in-flight state, never "failed". NEVER redials.
 */
export async function recoverOrphanedCalls(d: {
  db: Db;
  clock: Clock;
  adapter: TelegramCallAdapter;
  registry: ActiveCallRegistry;
  callBudgetMicroUsd: number;
}): Promise<{ recovered: number }> {
  const rows = await d.db.query<{ id: string; owner_id: string; call_request_id: string; provider_call_id: string | null; state: CallState }>(
    `SELECT id, owner_id, call_request_id, provider_call_id, state FROM calls
     WHERE state IN ('preflight','dialing','ringing','connected','awaiting_consent','active','ending')`,
  );
  let recovered = 0;
  for (const r of rows.rows) {
    if (d.registry.list(r.owner_id).some((c) => c.callId === r.id)) continue;
    const now = d.clock.now();
    const rec = r.provider_call_id ? await d.adapter.reconcile(r.provider_call_id).catch(() => 'unknown' as const) : ('unknown' as const);
    await d.db.tx(async (c) => {
      let variant: 'ended' | 'outcome_unknown' = 'ended';
      if (r.state === 'preflight') {
        // Intent was persisted but we never reached the provider: nothing was dialed. Fail it; fresh authority is required.
        await transitionCall(c, r.owner_id, r.id, 'cancelled', { endReason: 'cancelled', now });
        await settleCallBudget(c, r.owner_id, r.id, 0, now);
      } else if (rec === 'ended') {
        if (r.state === 'dialing' || r.state === 'ringing') await transitionCall(c, r.owner_id, r.id, 'failed', { endReason: 'transport_error', now });
        else {
          if (r.state !== 'ending') await transitionCall(c, r.owner_id, r.id, 'ending', { now });
          await transitionCall(c, r.owner_id, r.id, 'ended', { endReason: 'transport_error', now });
        }
        // A call that had connected may have spent money before the crash: settle it at the reservation. One that never connected spent nothing.
        await settleCallBudget(c, r.owner_id, r.id, r.state === 'dialing' || r.state === 'ringing' ? 0 : null, now); // the ORIGINAL reservation (day and amount are on the call row)
      } else {
        // The provider did not confirm the end (active or unknown): the call may be live. Keep the account occupied and the
        // reservation reserved until an operator resolves it.
        await transitionCall(c, r.owner_id, r.id, 'outcome_unknown', { endReason: 'outcome_unknown', now });
        variant = 'outcome_unknown';
      }
      await c.query(`UPDATE call_requests SET status='failed' WHERE id=$1 AND status IN ('dialing','preflight')`, [r.call_request_id]);
      await emitOutbox(
        c,
        { ownerId: r.owner_id, aggregateType: 'call', aggregateId: r.id, type: 'call.notify', payload: { variant, reason: 'transport_error' } },
        now,
      );
      await writeAudit(c, {
        ownerId: r.owner_id,
        actorType: 'system',
        action: 'call.recover',
        resourceType: 'call',
        resourceId: r.id,
        allowed: true,
        reasonCode: `recovered_from_${r.state}_${variant}`,
      });
    });
    recovered++;
  }
  return { recovered };
}
