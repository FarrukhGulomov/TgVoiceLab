import { describe, expect, it } from 'vitest';
import type { ApprovedCallPlan } from '@tgvl/contracts';
import { evaluateDialPolicy, type DialDenial, type DialPolicyInput } from '../../apps/assistant/src/modules/policy/dial-policy.js';
import { computePlanHash, planBodyOf } from '../../apps/assistant/src/modules/calls/plan-hash.js';
import { transitionCall, canTransition, TERMINAL, type CallState } from '../../apps/assistant/src/modules/calls/state-machine.js';

const NOW = new Date('2026-10-15T06:00:00Z'); // 11:00 Samarkand, Thursday
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function makePlan(over: Partial<ApprovedCallPlan> = {}): ApprovedCallPlan {
  const base = {
    callRequestId: U(1), ownerId: U(2), recipientTelegramId: '555000111', topic: 'credit-workflow',
    purpose: 'Find out whether today’s credit-workflow errors are fixed',
    questions: ['Are the errors fixed?', 'If not, what blocks the fix and when will it be ready?'],
    allowedContext: ['credit workflow incident of 2026-10-15'], forbiddenCommitments: ['payments', 'contracts', 'deadlines on the owner’s behalf'],
    language: 'en' as const, maxDurationSeconds: 300, expiresAt: '2026-10-15T09:00:00.000Z',
    ...over,
  };
  const planHash = computePlanHash(planBodyOf({ ...base, authorizationId: U(3), permissionVersion: 4, planHash: '0'.repeat(64) }));
  return { ...base, authorizationId: U(3), permissionVersion: 4, planHash };
}

function baseline(over: Partial<DialPolicyInput> = {}, planOver: Partial<ApprovedCallPlan> = {}): DialPolicyInput {
  const plan = makePlan(planOver);
  return {
    now: NOW, kind: 'contact_call', policyVersion: 7,
    owner: { id: U(2), disabled: false, timezone: 'Asia/Samarkand', quietHours: { enabled: true, start: '22:00', end: '08:00' }, callOptOut: false, verified: true },
    plan,
    authorization: { id: U(3), ownerId: U(2), state: 'approved', expiresAt: new Date(plan.expiresAt), planHash: plan.planHash },
    contact: { id: U(9), telegramUserId: '555000111', verifiedAt: new Date('2026-10-01T00:00:00Z'), timezone: 'Asia/Samarkand' },
    permission: { version: 4, allowCall: true, topicScopes: ['credit-workflow'], allowedHours: { start: '09:00', end: '18:00' }, expiresAt: new Date('2026-12-01T00:00:00Z'), revokedAt: null },
    capability: { privateOutbound: true, pcmSend: true, pcmReceive: true, productionCallingAllowed: true, thirdPartyConsentMechanismProven: true, buildFingerprintMatches: true },
    accountHealthy: true, killSwitchOn: false, activeCallExists: false, budgetReserved: true,
    ...over,
  };
}

describe('dial policy (spec §9.1)', () => {
  it('allows the fully valid baseline', () => {
    expect(evaluateDialPolicy(baseline())).toMatchObject({ allowed: true, reasonCode: 'ok', policyVersion: 7, authorizationId: U(3) });
  });

  const cases: Array<[DialDenial, (b: DialPolicyInput) => Partial<DialPolicyInput>]> = [
    ['owner_disabled', (b) => ({ owner: { ...b.owner, disabled: true } })],
    ['owner_unverified', (b) => ({ owner: { ...b.owner, verified: false } })],
    ['kill_switch_on', () => ({ killSwitchOn: true })],
    ['calling_not_verified', (b) => ({ capability: { ...b.capability, productionCallingAllowed: false } })],
    ['calling_not_verified', (b) => ({ capability: { ...b.capability, pcmReceive: false } })],
    ['calling_not_verified', (b) => ({ capability: { ...b.capability, buildFingerprintMatches: false } })],
    ['account_unhealthy', () => ({ accountHealthy: false })],
    ['active_call_exists', () => ({ activeCallExists: true })],
    ['authorization_missing', () => ({ authorization: null })],
    ['authorization_missing', (b) => ({ authorization: { ...b.authorization!, id: U(77) } })],
    ['authorization_owner_mismatch', (b) => ({ authorization: { ...b.authorization!, ownerId: U(99) } })],
    ['authorization_not_approved', (b) => ({ authorization: { ...b.authorization!, state: 'pending' } })],
    ['authorization_not_approved', (b) => ({ authorization: { ...b.authorization!, state: 'consumed' } })], // single-use
    ['authorization_not_approved', (b) => ({ authorization: { ...b.authorization!, state: 'revoked' } })],
    ['authorization_expired', (b) => ({ authorization: { ...b.authorization!, expiresAt: new Date(NOW.getTime() - 1) } })],
    ['plan_hash_mismatch', (b) => ({ plan: { ...b.plan, purpose: 'Ask about something else entirely' } })], // material change after approval
    ['plan_hash_mismatch', (b) => ({ plan: { ...b.plan, recipientTelegramId: '999' } })],
    ['plan_hash_mismatch', (b) => ({ plan: { ...b.plan, questions: [...b.plan.questions, 'Also, can you pay invoice 42?'] } })],
    ['plan_hash_mismatch', (b) => ({ authorization: { ...b.authorization!, planHash: 'f'.repeat(64) } })],
    ['plan_expired', (b) => { const p = makePlan({ expiresAt: '2026-10-15T05:59:59.000Z' }); return { plan: p, authorization: { ...b.authorization!, planHash: p.planHash } }; }],
    ['recipient_missing', () => ({ contact: null })],
    ['recipient_unverified', (b) => ({ contact: { ...b.contact!, verifiedAt: null } })],
    ['recipient_mismatch', (b) => ({ contact: { ...b.contact!, telegramUserId: '555000999' } })],
    ['permission_missing', () => ({ permission: null })],
    ['permission_revoked', (b) => ({ permission: { ...b.permission!, revokedAt: new Date(NOW.getTime() - 1000) } })],
    ['permission_expired', (b) => ({ permission: { ...b.permission!, expiresAt: new Date(NOW.getTime() - 1) } })],
    ['permission_version_stale', (b) => ({ permission: { ...b.permission!, version: 5 } })],
    ['permission_denies_call', (b) => ({ permission: { ...b.permission!, allowCall: false } })],
    ['topic_not_permitted', (b) => ({ permission: { ...b.permission!, topicScopes: ['invoices'] } })],
    ['outside_allowed_hours', () => ({ ...baseline({ now: new Date('2026-10-15T14:00:00Z') }, { expiresAt: '2026-10-16T00:00:00.000Z' }) })], // 19:00 local, outside 09:00-18:00
    ['consent_mechanism_unproven', (b) => ({ capability: { ...b.capability, thirdPartyConsentMechanismProven: false } })],
    ['budget_not_reserved', () => ({ budgetReserved: false })],
  ];
  it.each(cases.map((c, i) => [c[0], i] as const))('denies: %s (case %i)', (code, idx) => {
    const b = baseline();
    const d = evaluateDialPolicy({ ...b, ...cases[idx]![1](b) });
    expect(d.allowed).toBe(false);
    expect(d.reasonCode).toBe(code);
  });

  it('a permitted-but-ALLOWLISTED contact with no authorization is not dialable (allowlist alone is not authority)', () => {
    expect(evaluateDialPolicy(baseline({ authorization: null })).allowed).toBe(false);
  });

  it('owner calls: opt-out and quiet hours deny; contact rules do not apply', () => {
    const b = baseline({ kind: 'owner_call', contact: null, permission: null }, { expiresAt: '2026-10-16T00:00:00.000Z' });
    expect(evaluateDialPolicy(b).allowed).toBe(true);
    expect(evaluateDialPolicy({ ...b, owner: { ...b.owner, callOptOut: true } }).reasonCode).toBe('owner_opted_out');
    expect(evaluateDialPolicy({ ...b, now: new Date('2026-10-15T18:30:00Z') }).reasonCode).toBe('quiet_hours'); // 23:30 local
  });

  it('kill switch outranks everything else', () => {
    const b = baseline();
    expect(evaluateDialPolicy({ ...b, killSwitchOn: true, authorization: null, contact: null }).reasonCode).toBe('kill_switch_on');
  });

  it('plan hash covers every approved field but is stable under key order and ignores approval metadata', () => {
    const p = makePlan();
    const reordered = JSON.parse(JSON.stringify(planBodyOf(p), Object.keys(planBodyOf(p)).sort().reverse()));
    expect(computePlanHash(reordered)).toBe(p.planHash);
    const different = makePlan({ maxDurationSeconds: 301 });
    expect(different.planHash).not.toBe(p.planHash);
  });
});

describe('call state machine edges', () => {
  it('terminal states have no outgoing edges', () => {
    for (const s of TERMINAL) for (const t of ['dialing', 'ringing', 'connected', 'active', 'ending'] as CallState[]) expect(canTransition(s, t)).toBe(false);
  });
  it('cannot skip consent: connected -> active is illegal; only awaiting_consent -> active', () => {
    expect(canTransition('connected', 'active')).toBe(false);
    expect(canTransition('dialing', 'active')).toBe(false);
    expect(canTransition('awaiting_consent', 'active')).toBe(true);
  });
  it('every connected state can be forced to end (withdrawal / kill switch / limit / transport loss)', () => {
    for (const s of ['connected', 'awaiting_consent', 'active'] as CallState[]) expect(canTransition(s, 'ending')).toBe(true);
  });
  it('a transition without an end reason to a reason-requiring terminal state is a programming error', async () => {
    await expect(transitionCall({ query: async () => ({ rows: [], rowCount: 0 } as never) }, 'o', 'c', 'declined', { now: NOW })).rejects.toThrow(/requires an end reason/);
  });
});
