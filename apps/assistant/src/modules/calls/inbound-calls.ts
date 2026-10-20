import { randomUUID } from 'node:crypto';
import type { Db } from '../../infrastructure/db/db.js';
import type { Clock } from '../../application/clock.js';
import { OWNER_CALLED_IN } from '../../application/intent.js';
import type { AuthorizationService } from './authorizations.service.js';
import type { CallOrchestrator } from './orchestrator.js';
import type { DerivedCapabilities } from './capability-evidence.js';
import type { IncomingCall } from './ntgcalls/adapter.js';
import type { DiscardKind } from './ntgcalls/ports.js';

export interface InboundCallAdapter {
  registerIncoming(callRequestId: string, call: IncomingCall): void;
  releaseIncoming(callRequestId: string): IncomingCall | undefined;
  declineIncoming(call: IncomingCall, kind?: DiscardKind): Promise<void>;
}

export interface InboundCallDeps {
  db: Db;
  authorizations: Pick<AuthorizationService, 'createCallRequest'>;
  orchestrator: Pick<CallOrchestrator, 'dial'>;
  adapter: InboundCallAdapter;
  clock: Clock;
  callsEnabled: boolean;
  derive: () => Pick<DerivedCapabilities, 'ownerCallingAllowed'>;
  /** Longest an answered call may last. */
  maxDurationSeconds?: number;
  log?: ((line: string) => void) | undefined;
}

const MAX_DECLINES_PER_MINUTE = 5;

/**
 * Phase 1 of answering calls: ONLY the owner's own calls to the assistant account. A ring from the numeric owner id becomes an owner-approved
 * call request (the owner calling IS the explicit command) and goes through the same orchestrator as every other call: policy re-checks,
 * the kill switch, the single-active-call rule, the call budget, durable call state, events and report. The adapter answers the ring
 * instead of placing a call. Anyone else is declined as busy, without any conversation, and never recorded as a contact.
 */
export class InboundCallService {
  #declines = new Map<string, number[]>();

  constructor(private readonly d: InboundCallDeps) {}

  /** Handles one ring. Never throws: any failure declines the ring. */
  async handle(call: IncomingCall): Promise<void> {
    const { db, adapter } = this.d;
    const owner = (
      await db.query<{ id: string; locale: 'uz' | 'en' | 'ru'; disabled: boolean }>('SELECT id, locale, disabled FROM owners WHERE telegram_user_id=$1', [
        call.callerId,
      ])
    ).rows[0];
    if (!owner) return this.#decline(call, 'a ring from someone who is not the owner');
    if (owner.disabled) return this.#decline(call, 'the owner account is disabled');
    if (!this.d.callsEnabled) return this.#decline(call, 'calls are switched off');
    if (!this.d.derive().ownerCallingAllowed) return this.#decline(call, 'owner calls are not verified for this build');

    const now = this.d.clock.now();
    const callRequestId = randomUUID();
    try {
      await this.d.authorizations.createCallRequest(
        owner.id,
        {
          callRequestId,
          ownerId: owner.id,
          recipientTelegramId: call.callerId,
          topic: 'reminder',
          purpose: "Egasi o'zi qo'ng'iroq qildi",
          questions: [],
          allowedContext: [OWNER_CALLED_IN],
          forbiddenCommitments: [],
          language: owner.locale,
          maxDurationSeconds: this.d.maxDurationSeconds ?? 600,
          expiresAt: new Date(now.getTime() + 2 * 60_000).toISOString(), // a ring that is not answered within seconds is gone
        },
        { ownerExplicitCommand: true },
      );
    } catch (e) {
      return this.#decline(call, `could not record the call (${String((e as Error)?.message ?? e).slice(0, 80)})`);
    }
    adapter.registerIncoming(callRequestId, call);
    this.d.log?.('inbound call: the owner is calling, answering');
    // The orchestrator drives the whole call (policy, the answer through the adapter, conversation, report) and returns when it is over.
    void this.d.orchestrator
      .dial(owner.id, callRequestId, { inbound: true })
      .then(
        (outcome) => {
          this.d.log?.(
            outcome.status === 'rejected'
              ? `inbound call: refused by policy (${outcome.reason})`
              : `inbound call: over (${outcome.status}${'state' in outcome ? `, ${outcome.state}` : ''}${'endReason' in outcome ? `, ${outcome.endReason}` : ''})`,
          );
        },
        (e: unknown) => this.d.log?.(`inbound call: failed (${String((e as Error)?.message ?? e).slice(0, 80)})`),
      )
      .finally(() => {
        // A request refused before the adapter took the ring leaves it ringing: hang that up.
        const stray = adapter.releaseIncoming(callRequestId);
        if (stray) void adapter.declineIncoming(stray, 'busy');
      });
  }

  async #decline(call: IncomingCall, why: string): Promise<void> {
    const now = Date.now();
    const recent = (this.#declines.get(call.callerId) ?? []).filter((t) => now - t < 60_000);
    recent.push(now);
    this.#declines.set(call.callerId, recent);
    if (this.#declines.size > 200) this.#declines.delete(this.#declines.keys().next().value as string);
    this.d.log?.(`inbound call: declined (${why})`); // never logs who called
    if (recent.length > MAX_DECLINES_PER_MINUTE) return; // a ring storm is ignored, not answered one by one
    await this.d.adapter.declineIncoming(call, 'busy');
  }
}
