import type { CallEndReason } from '@tgvl/contracts';
import type { Queryable } from '../../infrastructure/db/db.js';

export type CallState =
  | 'preflight'
  | 'dialing'
  | 'ringing'
  | 'connected'
  | 'awaiting_consent'
  | 'active'
  | 'ending'
  | 'ended'
  | 'rejected'
  | 'cancelled'
  | 'expired'
  | 'declined'
  | 'busy'
  | 'no_answer'
  | 'failed'
  | 'outcome_unknown'
  | 'consent_denied';

/** Spec §7 state machine. Terminal states have no outgoing edges (except outcome_unknown, which is resolved by reconciliation). */
const EDGES: Record<CallState, readonly CallState[]> = {
  preflight: ['dialing', 'rejected', 'cancelled', 'expired'],
  dialing: ['ringing', 'connected', 'declined', 'busy', 'no_answer', 'failed', 'outcome_unknown', 'cancelled'],
  ringing: ['connected', 'declined', 'busy', 'no_answer', 'failed', 'outcome_unknown', 'cancelled'],
  connected: ['awaiting_consent', 'ending', 'failed', 'outcome_unknown'],
  awaiting_consent: ['active', 'consent_denied', 'ending', 'failed', 'cancelled', 'outcome_unknown'],
  active: ['ending', 'failed', 'outcome_unknown'],
  ending: ['ended', 'failed', 'outcome_unknown'],
  outcome_unknown: ['ended', 'failed', 'cancelled'],
  ended: [],
  rejected: [],
  cancelled: [],
  expired: [],
  declined: [],
  busy: [],
  no_answer: [],
  failed: [],
  consent_denied: [],
};

/** States that no longer occupy the account (mirrors the partial unique index in the schema). */
export const TERMINAL: ReadonlySet<CallState> = new Set([
  'ended',
  'rejected',
  'cancelled',
  'expired',
  'declined',
  'busy',
  'no_answer',
  'failed',
  'consent_denied',
]);
const NEEDS_END_REASON: ReadonlySet<CallState> = new Set(['ended', 'declined', 'busy', 'no_answer', 'failed', 'consent_denied', 'cancelled']);

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: CallState,
    readonly to: CallState,
  ) {
    super(`illegal call transition ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export const canTransition = (from: CallState, to: CallState) => EDGES[from].includes(to);
const predecessors = (to: CallState): CallState[] => (Object.keys(EDGES) as CallState[]).filter((s) => EDGES[s].includes(to));

export interface TransitionPatch {
  endReason?: CallEndReason | undefined;
  providerCallId?: string | undefined;
  consentState?: 'pending' | 'granted' | 'denied' | 'withdrawn' | undefined;
  now: Date;
}

/**
 * Atomic compare-and-set transition. Idempotent for terminal events: re-applying the state we are already in is a no-op
 * (`changed: false`), so duplicate provider events cannot double-apply side effects. An illegal edge throws.
 */
export async function transitionCall(
  q: Queryable,
  ownerId: string,
  callId: string,
  to: CallState,
  p: TransitionPatch,
): Promise<{ changed: boolean; state: CallState }> {
  if (NEEDS_END_REASON.has(to) && !p.endReason) throw new Error(`transition to ${to} requires an end reason`);
  const r = await q.query<{ state: CallState }>(
    `UPDATE calls SET state=$4,
        end_reason = COALESCE($5, end_reason),
        provider_call_id = COALESCE($6, provider_call_id),
        consent_state = COALESCE($7, consent_state),
        connected_at = CASE WHEN $4 = 'connected' THEN $8 ELSE connected_at END,
        ended_at = CASE WHEN $9 THEN $8 ELSE ended_at END
     WHERE id=$1 AND owner_id=$2 AND state = ANY($3) RETURNING state`,
    [callId, ownerId, predecessors(to), to, p.endReason ?? null, p.providerCallId ?? null, p.consentState ?? null, p.now, TERMINAL.has(to)],
  );
  if (r.rows[0]) return { changed: true, state: to };
  const cur = await q.query<{ state: CallState }>('SELECT state FROM calls WHERE id=$1 AND owner_id=$2', [callId, ownerId]);
  const from = cur.rows[0]?.state;
  if (!from) throw new Error('call not found');
  if (from === to) return { changed: false, state: from }; // idempotent duplicate
  if (TERMINAL.has(from) && TERMINAL.has(to)) return { changed: false, state: from }; // late conflicting terminal event: first terminal wins
  throw new IllegalTransitionError(from, to);
}
