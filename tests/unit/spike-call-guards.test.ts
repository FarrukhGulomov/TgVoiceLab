import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script helpers, no type declarations
import * as G from '../../experiments/telegram-calls/call-guards.mjs';

/**
 * Audit F05/F06: the experimental real-call script must stop after an uncertain placement, bind every update to the call it placed,
 * re-check the authorization window before each placement, and derive G0-E evidence from what it observed. All offline, fake provider.
 */
const rpcError = (m: string) => Object.assign(new Error(m), { errorMessage: m, code: 400 });
const netError = () => Object.assign(new Error('TIMEOUT'), {});
const call = (id: string, over: Record<string, unknown> = {}) => ({
  className: 'PhoneCallWaiting',
  id: BigInt(id),
  adminId: 111n,
  participantId: 222n,
  ...over,
});

describe('F05 placement tracking and batch abort', () => {
  it('an RPC rejection from the server proves nothing was placed; a timeout does not', () => {
    const a = new G.PlacementTracker();
    a.markSubmitted();
    a.markSubmitFailed(rpcError('USER_PRIVACY_RESTRICTED'));
    expect(a.phase).toBe('not_submitted');
    const b = new G.PlacementTracker();
    b.markSubmitted();
    b.markSubmitFailed(netError());
    expect(b.phase).toBe('submitted_unknown');
  });
  it('batch continues only when the previous call is proven ended or never placed', async () => {
    const seen: number[] = [];
    const outcomes = ['ended_confirmed', 'not_submitted', 'ended_confirmed'];
    const r = await G.runBatch({
      repeat: 3,
      checkWindow: () => null,
      place: async (n: number) => (seen.push(n), { placement: outcomes[n - 1], ok: true }),
      pause: async () => undefined,
    });
    expect(seen).toEqual([1, 2, 3]);
    expect(r.aborted).toBeNull();
  });
  for (const bad of ['submitted_unknown', 'confirmed', 'ended_unproven']) {
    it(`a call left in "${bad}" aborts the whole batch: no second RequestCall`, async () => {
      const seen: number[] = [];
      const r = await G.runBatch({
        repeat: 5,
        checkWindow: () => null,
        place: async (n: number) => (seen.push(n), { placement: bad, ok: false }),
        pause: async () => undefined,
      });
      expect(seen).toEqual([1]);
      expect(r.aborted).toMatch(/outcome|not proven ended|uncertain/i);
    });
  }
  it('the authorization window is re-checked before EVERY placement', async () => {
    let checks = 0;
    const seen: number[] = [];
    const r = await G.runBatch({
      repeat: 4,
      checkWindow: () => (++checks >= 3 ? 'now is outside the authorized test window' : null),
      place: async (n: number) => (seen.push(n), { placement: 'ended_confirmed', ok: true }),
      pause: async () => undefined,
    });
    expect(seen).toEqual([1, 2]);
    expect(r.aborted).toMatch(/authorized test window/);
  });
  it('validates repetitions, seconds and frame duration as integers in range', () => {
    expect(G.parseIntInRange('3', 1, 10, 'R')).toEqual({ value: 3 });
    expect(G.parseIntInRange('2.5', 1, 10, 'R').error).toMatch(/integer/);
    expect(G.parseIntInRange('11', 1, 10, 'R').error).toMatch(/between/);
    expect(G.parseFrameMs(undefined)).toEqual({ value: 10 });
    expect(G.parseFrameMs('20')).toEqual({ value: 20 });
    expect(G.parseFrameMs('15').error).toMatch(/multiple of 10/);
    expect(G.parseFrameMs('0').error).toBeDefined();
    expect(G.parseFrameMs('100').error).toBeDefined();
  });
  it('window check reports outside / inverted / oversized windows', () => {
    const t = Date.parse('2026-10-16T10:30:00Z');
    expect(G.windowProblem(t, Date.parse('2026-10-16T10:00:00Z'), Date.parse('2026-10-16T11:00:00Z'))).toBeNull();
    expect(G.windowProblem(t, Date.parse('2026-10-16T10:40:00Z'), Date.parse('2026-10-16T11:00:00Z'))).toMatch(/outside/);
    expect(G.windowProblem(t, Date.parse('2026-10-16T11:00:00Z'), Date.parse('2026-10-16T10:00:00Z'))).toMatch(/positive/);
    expect(G.windowProblem(t, Date.parse('2026-10-16T08:00:00Z'), Date.parse('2026-10-16T11:00:00Z'))).toMatch(/2 hours/);
  });
});

describe('F06 updates are bound to the call that was placed', () => {
  const gate = () => new G.CallUpdateGate({ selfId: '111', recipientId: '222' });
  it('ignores unrelated incoming / concurrent calls before and after our call is known', () => {
    const g = gate();
    expect(g.classifyPhoneCall(call('900', { className: 'PhoneCallRequested', adminId: 333n, participantId: 111n }))).toBe('ignore'); // incoming from someone else
    g.bind(call('500'));
    expect(g.classifyPhoneCall(call('900', { className: 'PhoneCallAccepted' }))).toBe('ignore');
    expect(g.classifyPhoneCall(call('900', { className: 'PhoneCallDiscarded' }))).toBe('ignore');
    expect(g.classifySignaling({ phoneCallId: 900n })).toBe('ignore');
    expect(g.classifyPhoneCall(call('500', { className: 'PhoneCallAccepted' }))).toBe('accept');
    expect(g.classifySignaling({ phoneCallId: 500n })).toBe('accept');
  });
  it('an update for our call id with the wrong participants is refused', () => {
    const g = gate();
    g.bind(call('500'));
    expect(g.classifyPhoneCall(call('500', { className: 'PhoneCallAccepted', participantId: 999n }))).toBe('ignore');
    expect(g.classifyPhoneCall(call('500', { className: 'PhoneCallAccepted', adminId: 999n }))).toBe('ignore');
  });
  it('early updates (before the request response) are buffered, bounded, and replayed only if they match', () => {
    const g = new G.CallUpdateGate({ selfId: '111', recipientId: '222', maxBuffered: 3 });
    const early = [call('500', { className: 'PhoneCallAccepted' }), call('900', { className: 'PhoneCallDiscarded' })];
    expect(g.classifyPhoneCall(early[0])).toBe('buffer');
    g.buffer(early[0]);
    g.buffer(early[1]);
    for (let i = 0; i < 10; i++) g.buffer(call('901'));
    expect(g.droppedEarly).toBeGreaterThan(0);
    const replay = g.bind(call('500'));
    expect(replay.map((u: { id: bigint }) => String(u.id))).toEqual(['500']); // the unrelated ones are dropped
  });
  it('cleanup targets only the bound call', () => {
    const g = gate();
    expect(g.cleanupTarget()).toBeNull();
    g.bind(call('500'));
    expect(g.cleanupTarget()).toMatchObject({ id: 500n });
  });
});

describe('G0-E evidence is derived from observed attempts and an explicit expected reason', () => {
  const base = { scenario: 'expect_decline', expectedReason: 'PhoneCallDiscardReasonBusy', accepted: false, connected: false };
  it('passes only for the exact expected reason, one RequestCall, and no accept', () => {
    expect(G.g0eVerdict({ ...base, discardReason: 'PhoneCallDiscardReasonBusy', requestCalls: 1 }).ok).toBe(true);
    expect(G.g0eVerdict({ ...base, discardReason: 'PhoneCallDiscardReasonHangup', requestCalls: 1 }).ok).toBe(false);
    expect(G.g0eVerdict({ ...base, discardReason: 'PhoneCallDiscardReasonBusy', requestCalls: 2 })).toMatchObject({ ok: false, noRedial: false });
    expect(G.g0eVerdict({ ...base, discardReason: 'PhoneCallDiscardReasonBusy', requestCalls: 1, accepted: true }).ok).toBe(false);
    expect(G.g0eVerdict({ ...base, discardReason: null, requestCalls: 1 }).ok).toBe(false);
  });
  it('noRedial is derived from the observed count, never a constant', () => {
    expect(G.g0eVerdict({ ...base, discardReason: 'PhoneCallDiscardReasonBusy', requestCalls: 1 }).noRedial).toBe(true);
    expect(G.g0eVerdict({ ...base, discardReason: 'PhoneCallDiscardReasonBusy', requestCalls: 3 }).noRedial).toBe(false);
  });
});
