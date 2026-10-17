import type { ApprovedCallPlan, PolicyDecision } from '@tgvl/contracts';
import { computePlanHash, planBodyOf } from '../calls/plan-hash.js';
import { inQuietHours, type QuietHours } from '../scheduling/quiet-hours.js';
import { DateTime } from 'luxon';

/**
 * Deterministic authorization for dialing (spec §9.1). Pure: all facts are loaded by the caller, so every denial path is
 * unit-testable, and the model has no way to influence the result. The FIRST failing check wins (stable reason codes).
 */
export interface DialPolicyInput {
  now: Date;
  kind: 'contact_call' | 'owner_call';
  policyVersion: number;
  owner: { id: string; disabled: boolean; timezone: string; quietHours: QuietHours; callOptOut: boolean; verified: boolean };
  plan: ApprovedCallPlan;
  /** Lifecycle status of the call request being dialed; only `queued` is dialable (cancellation must stick, audit F12). */
  requestStatus: string;
  /** CALLS_ENABLED as configured. Calling needs this AND the evidence gates; neither substitutes for the other. */
  callingEnabled: boolean;
  authorization: { id: string; ownerId: string; state: string; expiresAt: Date; planHash: string } | null;
  contact: {
    id: string;
    telegramUserId: string;
    verifiedAt: Date | null;
    timezone: string | null;
    /** The OWNER's attestation that this contact was told about AI calls in advance (not the contact's own consent). */
    aiConsentAttestedAt: Date | null;
    aiConsentRevokedAt: Date | null;
  } | null;
  permission: {
    version: number;
    allowCall: boolean;
    topicScopes: readonly string[];
    allowedHours: { start: string; end: string } | null;
    expiresAt: Date;
    revokedAt: Date | null;
  } | null;
  capability: {
    privateOutbound: boolean;
    pcmSend: boolean;
    pcmReceive: boolean;
    productionCallingAllowed: boolean;
    /** Calls TO THE OWNER (G0-A..C + G0-D5, or the full set). Contact calls need `productionCallingAllowed`. */
    ownerCallingAllowed: boolean;
    thirdPartyConsentMechanismProven: boolean;
    buildFingerprintMatches: boolean;
  };
  accountHealthy: boolean;
  killSwitchOn: boolean;
  activeCallExists: boolean;
  budgetReserved: boolean;
}

export type DialDenial =
  | 'owner_disabled'
  | 'owner_unverified'
  | 'kill_switch_on'
  | 'calling_not_verified'
  | 'account_unhealthy'
  | 'active_call_exists'
  | 'authorization_missing'
  | 'authorization_owner_mismatch'
  | 'authorization_not_approved'
  | 'authorization_expired'
  | 'plan_hash_mismatch'
  | 'plan_expired'
  | 'request_not_dialable'
  | 'calls_disabled'
  | 'recipient_missing'
  | 'recipient_unverified'
  | 'recipient_mismatch'
  | 'permission_missing'
  | 'permission_revoked'
  | 'permission_expired'
  | 'permission_version_stale'
  | 'permission_denies_call'
  | 'topic_not_permitted'
  | 'outside_allowed_hours'
  | 'owner_opted_out'
  | 'quiet_hours'
  | 'budget_not_reserved'
  | 'consent_mechanism_unproven';

const withinWindow = (at: Date, tz: string, w: { start: string; end: string }): boolean => {
  const q: QuietHours = { enabled: true, start: w.end, end: w.start }; // outside [start,end) == inside [end,start)
  return !inQuietHours(at, tz, q);
};

export function evaluateDialPolicy(i: DialPolicyInput): PolicyDecision {
  const deny = (r: DialDenial): PolicyDecision => ({ allowed: false, reasonCode: r, policyVersion: i.policyVersion, authorizationId: i.plan.authorizationId });
  const t = i.now.getTime();

  if (i.owner.disabled) return deny('owner_disabled');
  if (!i.owner.verified) return deny('owner_unverified');
  if (i.killSwitchOn) return deny('kill_switch_on');
  if (!i.callingEnabled) return deny('calls_disabled');
  if (
    !i.capability.buildFingerprintMatches ||
    !i.capability.privateOutbound ||
    !i.capability.pcmSend ||
    !i.capability.pcmReceive ||
    !(i.kind === 'owner_call' ? i.capability.ownerCallingAllowed : i.capability.productionCallingAllowed)
  )
    return deny('calling_not_verified');
  if (!i.accountHealthy) return deny('account_unhealthy');
  if (i.activeCallExists) return deny('active_call_exists');

  const a = i.authorization;
  if (!a || a.id !== i.plan.authorizationId) return deny('authorization_missing');
  if (a.ownerId !== i.owner.id || i.plan.ownerId !== i.owner.id) return deny('authorization_owner_mismatch');
  if (a.state !== 'approved') return deny('authorization_not_approved'); // pending / consumed / revoked / expired all land here
  if (a.expiresAt.getTime() <= t) return deny('authorization_expired');
  // Any material plan change invalidates the approval: recompute from the body, compare to the plan AND to the approval.
  const recomputed = computePlanHash(planBodyOf(i.plan));
  if (recomputed !== i.plan.planHash || recomputed !== a.planHash) return deny('plan_hash_mismatch');
  if (new Date(i.plan.expiresAt).getTime() <= t) return deny('plan_expired');
  if (i.requestStatus !== 'queued') return deny('request_not_dialable');

  // "Stop calling me" is a durable owner switch for EVERY call the assistant would place (owner and contact calls alike).
  if (i.owner.callOptOut) return deny('owner_opted_out');

  if (i.kind === 'owner_call') {
    if (inQuietHours(i.now, i.owner.timezone, i.owner.quietHours)) return deny('quiet_hours');
  } else {
    const c = i.contact;
    if (!c) return deny('recipient_missing');
    // Participant consent to AI processing is established either by a live-verified local recognizer, or by the owner's recorded,
    // un-revoked attestation that the contact was informed in advance (owner decision 2026-10-17).
    const ownerAttested = !!c.aiConsentAttestedAt && (!c.aiConsentRevokedAt || c.aiConsentRevokedAt.getTime() < c.aiConsentAttestedAt.getTime());
    if (!i.capability.thirdPartyConsentMechanismProven && !ownerAttested) return deny('consent_mechanism_unproven');
    if (!c.verifiedAt) return deny('recipient_unverified');
    if (c.telegramUserId !== i.plan.recipientTelegramId) return deny('recipient_mismatch'); // numeric id is identity
    const p = i.permission;
    if (!p) return deny('permission_missing');
    if (p.revokedAt && p.revokedAt.getTime() <= t) return deny('permission_revoked');
    if (p.expiresAt.getTime() <= t) return deny('permission_expired');
    if (p.version !== i.plan.permissionVersion) return deny('permission_version_stale');
    if (!p.allowCall) return deny('permission_denies_call');
    if (!p.topicScopes.includes(i.plan.topic)) return deny('topic_not_permitted');
    if (p.allowedHours && !withinWindow(i.now, c.timezone ?? i.owner.timezone, p.allowedHours)) return deny('outside_allowed_hours');
  }

  if (!i.budgetReserved) return deny('budget_not_reserved');
  return { allowed: true, reasonCode: 'ok', policyVersion: i.policyVersion, authorizationId: i.plan.authorizationId };
}

export { DateTime };
