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
import type pg from 'pg';
import type { Db, Queryable } from '../../infrastructure/db/db.js';
import type { Clock } from '../../application/clock.js';
import { writeAudit } from '../audit/audit.js';
import { emitOutbox } from '../outbox/outbox.js';
import { evaluateDialPolicy, type DialPolicyInput } from '../policy/dial-policy.js';
import { ActiveCallRegistry, reserveBudget } from '../operations/operations.service.js';
import type { DerivedCapabilities } from './capability-evidence.js';
import { transitionCall, TERMINAL, type CallState } from './state-machine.js';
import type { DataCrypto } from '../../infrastructure/crypto/data-crypto.js';
import { openPlan, PlanIntegrityError } from './plan-store.js';

/**
 * Conversation layer port (Phase 3/4: media bridge, Realtime, consent gate, tools). NOT IMPLEMENTED: those phases are
 * blocked behind the Phase 0 gates. The default runner ends the call immediately, so no unverified conversational path exists.
 */
export interface CallSessionRunner {
  run(ctx: { callId: string; ownerId: string; plan: ApprovedCallPlan; handle: CallHandle }): Promise<{ endReason: CallEndReason }>;
}
export const noSessionRunner: CallSessionRunner = { run: async () => ({ endReason: 'cancelled' }) };

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
  ringTimeoutMs?: number;
}

class PolicyDenied extends Error {
  constructor(readonly reason: string) {
    super(`policy denied: ${reason}`);
  }
}

const REASON_TO_STATE: Partial<Record<CallEndReason, CallState>> = { declined: 'declined', busy: 'busy', no_answer: 'no_answer' };

export class CallOrchestrator {
  private readonly runner: CallSessionRunner;
  constructor(private readonly d: OrchestratorDeps) {
    this.runner = d.sessionRunner ?? noSessionRunner;
  }

  private dayKey(tz: string): string {
    return DateTime.fromJSDate(this.d.clock.now(), { zone: tz }).toFormat('yyyy-LL-dd');
  }

  /** Gather every fact the pure policy needs. `excludeCallId` lets the re-check ignore the row we just inserted. */
  async loadInput(
    q: Queryable,
    ownerId: string,
    callRequestId: string,
    o: { budgetReserved: boolean; excludeCallId?: string },
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
    const [own, auth, contact, perm, ks, acct] = await Promise.all([
      q.query<{
        id: string;
        disabled: boolean;
        timezone: string;
        quiet_hours: DialPolicyInput['owner']['quietHours'];
        call_opt_out: boolean;
        policy_version: number;
      }>('SELECT id, disabled, timezone, quiet_hours, call_opt_out, policy_version FROM owners WHERE id=$1', [ownerId]),
      q.query<{ id: string; owner_id: string; state: string; expires_at: Date; plan_hash: string }>(
        'SELECT id, owner_id, state, expires_at, plan_hash FROM authorizations WHERE id=$1',
        [req.rows[0].authorization_id],
      ),
      q.query<{ id: string; telegram_user_id: string; verified_at: Date | null; timezone: string | null }>(
        'SELECT id, telegram_user_id, verified_at, timezone FROM contacts WHERE id=$1 AND owner_id=$2',
        [req.rows[0].contact_id, ownerId],
      ),
      q.query<{
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
      q.query<{ calling_kill_switch: boolean }>('SELECT calling_kill_switch FROM operation_settings WHERE owner_id=$1', [ownerId]),
      q.query<{ id: string; status: string }>(`SELECT id, status FROM telegram_accounts WHERE owner_id=$1 ORDER BY created_at LIMIT 1`, [ownerId]),
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
      kind: 'contact_call',
      policyVersion: o0.policy_version,
      owner: { id: o0.id, disabled: o0.disabled, timezone: o0.timezone, quietHours: o0.quiet_hours, callOptOut: o0.call_opt_out, verified: true },
      plan,
      requestStatus: req.rows[0].status,
      authorization: a ? { id: a.id, ownerId: a.owner_id, state: a.state, expiresAt: a.expires_at, planHash: a.plan_hash } : null,
      contact: c ? { id: c.id, telegramUserId: c.telegram_user_id, verifiedAt: c.verified_at, timezone: c.timezone } : null,
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
        thirdPartyConsentMechanismProven: caps.thirdPartyConsentMechanismProven,
        // deriveCapabilities() yields evidenceArtifact=null whenever evidence is missing/invalid/bound to a different build.
        buildFingerprintMatches: caps.evidenceArtifact !== null,
      },
      accountHealthy: acct.rows[0]?.status === 'active',
      killSwitchOn: ks.rows[0]?.calling_kill_switch ?? true,
      activeCallExists: !!active.rowCount,
      budgetReserved: o.budgetReserved,
    };
  }

  private async reject(ownerId: string, callRequestId: string, reason: string): Promise<DialOutcome> {
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
      await emitOutbox(
        c,
        { ownerId, aggregateType: 'call_request', aggregateId: callRequestId, type: 'call.notify', payload: { variant: 'rejected', reason } },
        now,
      );
    });
    return { status: 'rejected', reason };
  }

  async dial(ownerId: string, callRequestId: string): Promise<DialOutcome> {
    const { db, clock } = this.d;
    // Pass 1 (read-only, no side effects): fail fast.
    let pre: DialPolicyInput | null;
    try {
      pre = await this.loadInput(db, ownerId, callRequestId, { budgetReserved: true });
    } catch (e) {
      if (e instanceof PolicyDenied) return this.reject(ownerId, callRequestId, e.reason);
      throw e;
    }
    if (!pre) return this.reject(ownerId, callRequestId, 'call_request_not_found');
    const first = evaluateDialPolicy(pre);
    if (!first.allowed) return this.reject(ownerId, callRequestId, first.reasonCode);
    const plan = pre.plan;
    const day = this.dayKey(pre.owner.timezone);

    // Pass 2: take the call row (the "lease"), consume the single-use authorization, reserve budget, and RE-EVALUATE with
    // fresh data inside the same transaction. Any denial rolls everything back — nothing is consumed by a refused dial.
    let callId: string;
    try {
      callId = await db.tx(async (c) => {
        await c.query('SELECT 1 FROM operation_settings WHERE owner_id=$1 FOR SHARE', [ownerId]);
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
        const reserved = await reserveBudget(c, ownerId, day, this.d.callBudgetMicroUsd);
        // Re-evaluate EVERY check with fresh data, after taking the call row and before the external side effect.
        const fresh = await this.loadInput(c, ownerId, callRequestId, { budgetReserved: reserved, excludeCallId: id });
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
          metadata: { callRequestId, attempt, planHash: plan.planHash },
        });
        return id;
      });
    } catch (e) {
      if (e instanceof PolicyDenied) return this.reject(ownerId, callRequestId, e.reason);
      if ((e as { code?: string }).code === '23505' && String((e as { constraint?: string }).constraint).includes('calls_one_active_per_account'))
        return this.reject(ownerId, callRequestId, 'active_call_exists');
      throw e;
    }

    // ---- external side effect: the intent is already durable ------------------------------------------------------
    const ac = new AbortController();
    this.d.registry.add({ callId, ownerId, contactId: pre.contact?.id ?? null, end: async () => ac.abort() });
    let handle: CallHandle;
    try {
      handle = await this.d.adapter.dial(plan, ac.signal);
    } catch (e) {
      this.d.registry.remove(callId);
      return this.onDialError(ownerId, callRequestId, callId, e, day);
    }
    return this.supervise(ownerId, callRequestId, callId, plan, handle, day, pre.contact?.id ?? null);
  }

  /** Dial failed. Distinguish "definitely not placed" from "may have been placed"; never redial in either case. */
  private async onDialError(ownerId: string, callRequestId: string, callId: string, e: unknown, day: string): Promise<DialOutcome> {
    const now = this.d.clock.now();
    if (e instanceof DialRejectedError) {
      const state: CallState = REASON_TO_STATE[e.reason] ?? 'failed';
      await this.d.db.tx(async (c) => {
        await transitionCall(c, ownerId, callId, state, { endReason: e.reason, now });
        await c.query(`UPDATE call_requests SET status='failed' WHERE id=$1`, [callRequestId]);
        await this.releaseBudget(c, ownerId, day);
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
        await this.releaseBudget(c, ownerId, day);
        await emitOutbox(
          c,
          { ownerId, aggregateType: 'call', aggregateId: callId, type: 'call.notify', payload: { variant: 'ended', reason: 'transport_error' } },
          now,
        );
      });
      return { status: 'finished', callId, state: 'failed', endReason: 'transport_error' };
    }
    // 'active' (we have no handle to control it) or 'unknown': the account stays occupied until an operator resolves it.
    await this.d.db.tx(async (c) => {
      await transitionCall(c, ownerId, callId, 'outcome_unknown', { endReason: 'outcome_unknown', providerCallId: providerId, now });
      await c.query(`UPDATE call_requests SET status='failed' WHERE id=$1`, [callRequestId]);
      await emitOutbox(c, { ownerId, aggregateType: 'call', aggregateId: callId, type: 'call.notify', payload: { variant: 'outcome_unknown' } }, now);
      await writeAudit(c, {
        ownerId,
        actorType: 'system',
        action: 'call.dial_result',
        resourceType: 'call',
        resourceId: callId,
        allowed: false,
        reasonCode: 'outcome_unknown',
      });
    });
    return { status: 'outcome_unknown', callId };
  }

  private async releaseBudget(c: pg.PoolClient, ownerId: string, day: string, actualMicro = 0) {
    await c.query(
      `UPDATE usage_budgets SET reserved_micro_usd = GREATEST(0, reserved_micro_usd - $3), actual_micro_usd = actual_micro_usd + $4 WHERE owner_id=$1 AND day=$2`,
      [ownerId, day, this.d.callBudgetMicroUsd, actualMicro],
    );
  }

  /** Consume adapter events with idempotent persistence; enforce ring timeout and duration cap; end safely on any loss. */
  private async supervise(
    ownerId: string,
    callRequestId: string,
    callId: string,
    plan: ApprovedCallPlan,
    handle: CallHandle,
    day: string,
    contactId: string | null,
  ): Promise<DialOutcome> {
    const { db, clock } = this.d;
    let seq = 0;
    let endReason: CallEndReason | null = null;
    let ending = false;
    const endOnce = async (reason: CallEndReason) => {
      if (ending) return;
      ending = true;
      endReason ??= reason;
      await handle.end(reason).catch(() => undefined);
    };
    this.d.registry.add({ callId, ownerId, contactId, end: (r) => endOnce(r) });

    const ringTimer = setTimeout(() => void endOnce('no_answer'), this.d.ringTimeoutMs ?? 30_000);
    let durTimer: NodeJS.Timeout | undefined;
    let connected = false;

    const record = async (ev: CallEvent): Promise<boolean> => {
      const r = await db.query(
        `INSERT INTO call_events (owner_id, call_id, provider_event_key, event_type, metadata, sequence, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (call_id, provider_event_key) DO NOTHING`,
        [ownerId, callId, ev.eventId, ev.type, JSON.stringify({ reason: ev.reason ?? null }), seq++, ev.occurredAt],
      );
      return r.rowCount === 1; // false => duplicate provider event, already applied
    };

    try {
      for await (const ev of handle.events) {
        if (!(await record(ev))) continue;
        const now = clock.now();
        if (ev.type === 'ringing') await transitionCall(db, ownerId, callId, 'ringing', { providerCallId: ev.providerCallId, now });
        else if (ev.type === 'connected') {
          clearTimeout(ringTimer);
          connected = true;
          await transitionCall(db, ownerId, callId, 'connected', { providerCallId: ev.providerCallId, now });
          durTimer = setTimeout(() => void endOnce('duration_limit'), plan.maxDurationSeconds * 1000);
          // Conversation (consent gate, Realtime, tools) is Phase 3/4. With no runner this ends the call at once.
          void this.runner.run({ callId, ownerId, plan, handle }).then(
            (r) => endOnce(r.endReason),
            () => endOnce('transport_error'),
          );
        } else if (ev.type === 'ended' || ev.type === 'error') {
          endReason ??= ev.reason ?? 'transport_error';
          break;
        }
      }
      if (endReason === null) endReason = 'transport_error'; // event stream closed without a terminal event: transport loss
    } catch {
      endReason ??= 'transport_error';
    } finally {
      clearTimeout(ringTimer);
      if (durTimer) clearTimeout(durTimer);
      this.d.registry.remove(callId);
    }

    const final = endReason;
    const now = clock.now();
    const cur = (await db.query<{ state: CallState }>('SELECT state FROM calls WHERE id=$1', [callId])).rows[0]!.state;
    const terminalState: CallState = !connected ? (REASON_TO_STATE[final] ?? 'failed') : 'ended';
    await db.tx(async (c) => {
      if (!TERMINAL.has(cur)) {
        if (connected && cur !== 'ending') await transitionCall(c, ownerId, callId, 'ending', { now });
        await transitionCall(c, ownerId, callId, terminalState, { endReason: final, now });
      }
      await c.query(`UPDATE call_requests SET status=$2 WHERE id=$1`, [callRequestId, final === 'completed' ? 'completed' : 'failed']);
      await this.releaseBudget(c, ownerId, day);
      // Truthful minimal report: no conversation layer exists yet, so the report is explicitly incomplete.
      await c.query(
        `INSERT INTO call_reports (call_id, owner_id, status, structured_result, complete) VALUES ($1,$2,'generated',$3,false) ON CONFLICT (call_id) DO NOTHING`,
        [callId, ownerId, JSON.stringify({ outcome: terminalState, endReason: final, conversationHeld: false, note: 'no conversation layer ran' })],
      );
      await emitOutbox(c, { ownerId, aggregateType: 'call', aggregateId: callId, type: 'call.notify', payload: { variant: 'ended', reason: final } }, now);
    });
    return { status: 'finished', callId, state: terminalState, endReason: final };
  }
}

/**
 * Crash recovery (spec §7, A11/A13). After a restart the in-process registry is empty, so any non-terminal call has lost its
 * supervisor. Reconcile with the provider where we have an id; otherwise mark outcome_unknown. NEVER redials.
 */
export async function recoverOrphanedCalls(d: {
  db: Db;
  clock: Clock;
  adapter: TelegramCallAdapter;
  registry: ActiveCallRegistry;
  callBudgetMicroUsd: number;
}): Promise<{ recovered: number }> {
  const live = new Set<string>();
  const rows = await d.db.query<{ id: string; owner_id: string; call_request_id: string; provider_call_id: string | null; state: CallState }>(
    `SELECT id, owner_id, call_request_id, provider_call_id, state FROM calls
     WHERE state IN ('preflight','dialing','ringing','connected','awaiting_consent','active','ending')`,
  );
  let recovered = 0;
  for (const r of rows.rows) {
    if (live.has(r.id) || d.registry.list(r.owner_id).some((c) => c.callId === r.id)) continue;
    const now = d.clock.now();
    const rec = r.provider_call_id ? await d.adapter.reconcile(r.provider_call_id).catch(() => 'unknown' as const) : ('unknown' as const);
    await d.db.tx(async (c) => {
      if (r.state === 'preflight') {
        // Intent was persisted but we never reached the provider: nothing was dialed. Fail it; fresh authority is required.
        await transitionCall(c, r.owner_id, r.id, 'cancelled', { endReason: 'cancelled', now });
      } else if (rec === 'ended') {
        if (r.state === 'dialing' || r.state === 'ringing') await transitionCall(c, r.owner_id, r.id, 'failed', { endReason: 'transport_error', now });
        else {
          if (r.state !== 'ending') await transitionCall(c, r.owner_id, r.id, 'ending', { now });
          await transitionCall(c, r.owner_id, r.id, 'ended', { endReason: 'transport_error', now });
        }
      } else if (r.state === 'dialing' || r.state === 'ringing') {
        await transitionCall(c, r.owner_id, r.id, 'outcome_unknown', { endReason: 'outcome_unknown', now });
      } else {
        // Was connected/active when we died and we have no handle: we cannot prove it ended. Fail closed, flag it.
        await transitionCall(c, r.owner_id, r.id, 'failed', { endReason: 'transport_error', now });
      }
      await c.query(`UPDATE call_requests SET status='failed' WHERE id=$1 AND status IN ('dialing','preflight')`, [r.call_request_id]);
      await c.query(`UPDATE usage_budgets SET reserved_micro_usd = GREATEST(0, reserved_micro_usd - $3) WHERE owner_id=$1 AND day = $2`, [
        r.owner_id,
        now.toISOString().slice(0, 10),
        d.callBudgetMicroUsd,
      ]);
      await emitOutbox(
        c,
        {
          ownerId: r.owner_id,
          aggregateType: 'call',
          aggregateId: r.id,
          type: 'call.notify',
          payload: { variant: r.state === 'dialing' || r.state === 'ringing' ? 'outcome_unknown' : 'ended', reason: 'transport_error' },
        },
        now,
      );
      await writeAudit(c, {
        ownerId: r.owner_id,
        actorType: 'system',
        action: 'call.recover',
        resourceType: 'call',
        resourceId: r.id,
        allowed: true,
        reasonCode: `recovered_from_${r.state}`,
      });
    });
    recovered++;
  }
  return { recovered };
}
