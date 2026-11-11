import { describe, expect, it } from 'vitest';
import { deriveCapabilities, GATE_IDS } from '../../apps/assistant/src/modules/calls/capability-evidence.js';
import { DisabledCallAdapter, EvidenceGatedCallAdapter } from '../../apps/assistant/src/modules/calls/adapters.js';
import { FakeCallAdapter } from '../../apps/assistant/src/testing/fakes.js';
import type { ApprovedCallPlan } from '@tgvl/contracts';

const FP = 'a'.repeat(64);
const gate = (result: 'PASS' | 'FAIL' | 'BLOCKED_EXTERNAL' = 'PASS', kind: 'live' | 'synthetic' | 'mock' = 'live') => ({
  result,
  kind,
  recordedAt: '2026-10-20T10:00:00Z',
  evidenceRefs: ['experiments/telegram-calls/evidence/x.json'],
});
const artifact = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    schemaVersion: 1,
    producedBy: 'production-adapter',
    buildFingerprint: FP,
    dependencyPins: { ntgcalls: '3.0.3' },
    gates: Object.fromEntries(GATE_IDS.map((g) => [g, gate()])),
    localConsentRecognizer: gate(),
    ...over,
  });
const read = (s: string) => () => s;

describe('capabilities are derived from evidence bound to the build', () => {
  it('no evidence configured => nothing is available', () => {
    const c = deriveCapabilities(null, FP);
    expect(c).toMatchObject({ privateOutbound: false, pcmSend: false, pcmReceive: false, productionCallingAllowed: false });
  });
  it('unreadable / malformed / schema-invalid evidence => nothing is available', () => {
    expect(
      deriveCapabilities('/x', FP, () => {
        throw new Error('ENOENT');
      }).productionCallingAllowed,
    ).toBe(false);
    expect(deriveCapabilities('/x', FP, read('not json')).productionCallingAllowed).toBe(false);
    expect(deriveCapabilities('/x', FP, read(JSON.stringify({ schemaVersion: 1 }))).productionCallingAllowed).toBe(false);
  });
  it('all six live PASS gates for this exact build => production calling allowed', () => {
    const c = deriveCapabilities('/x', FP, read(artifact()));
    expect(c).toMatchObject({ privateOutbound: true, pcmSend: true, pcmReceive: true, productionCallingAllowed: true, thirdPartyConsentMechanismProven: true });
  });
  it('evidence produced by the Phase 0 SPIKE can never enable production calling', () => {
    const c = deriveCapabilities('/x', FP, read(artifact({ producedBy: 'spike' })));
    expect(c).toMatchObject({ privateOutbound: false, pcmSend: false, productionCallingAllowed: false });
    expect(c.reasons.join(' ')).toMatch(/schema validation/);
  });
  it('evidence recorded for a different build fingerprint does not transfer', () => {
    expect(deriveCapabilities('/x', 'b'.repeat(64), read(artifact())).productionCallingAllowed).toBe(false);
  });
  it('MOCK or SYNTHETIC results can never pass a real-media gate', () => {
    for (const kind of ['mock', 'synthetic'] as const) {
      const c = deriveCapabilities('/x', FP, read(artifact({ gates: Object.fromEntries(GATE_IDS.map((g) => [g, gate('PASS', kind)])) })));
      expect(c.privateOutbound).toBe(false);
      expect(c.pcmSend).toBe(false);
      expect(c.productionCallingAllowed).toBe(false);
      expect(c.reasons.join(' ')).toMatch(/cannot pass a real-media gate/);
    }
  });
  it('BLOCKED_EXTERNAL / FAIL gates are not passes; partial progress enables only what is proven', () => {
    const gates = { ...Object.fromEntries(GATE_IDS.map((g) => [g, gate('BLOCKED_EXTERNAL')])), 'G0-A': gate(), 'G0-B': gate() };
    const c = deriveCapabilities('/x', FP, read(artifact({ gates })));
    expect(c).toMatchObject({ privateOutbound: true, pcmSend: false, productionCallingAllowed: false });
    const failB = { ...Object.fromEntries(GATE_IDS.map((g) => [g, gate()])), 'G0-B': gate('FAIL') };
    expect(deriveCapabilities('/x', FP, read(artifact({ gates: failB }))).privateOutbound).toBe(false);
  });
  it('third-party calls need a live-verified consent recognizer in addition to the gates', () => {
    expect(deriveCapabilities('/x', FP, read(artifact({ localConsentRecognizer: undefined }))).thirdPartyConsentMechanismProven).toBe(false);
    expect(deriveCapabilities('/x', FP, read(artifact({ localConsentRecognizer: gate('PASS', 'mock') }))).thirdPartyConsentMechanismProven).toBe(false);
  });
});

describe('adapters fail closed', () => {
  const plan = {} as ApprovedCallPlan;
  it('DisabledCallAdapter refuses to dial and reports no capability', async () => {
    const a = new DisabledCallAdapter(FP);
    expect(await a.capabilities()).toMatchObject({ privateOutbound: false, pcmSend: false, pcmReceive: false });
    await expect(a.dial()).rejects.toMatchObject({ code: 'capability_unavailable' });
    expect(await a.reconcile()).toBe('unknown');
  });
  it("EvidenceGatedCallAdapter ignores the inner adapter's own claims and refuses without evidence", async () => {
    const inner = new FakeCallAdapter(); // claims every capability
    const gated = new EvidenceGatedCallAdapter(inner, () => deriveCapabilities(null, FP));
    expect(await inner.capabilities()).toMatchObject({ privateOutbound: true });
    expect(await gated.capabilities()).toMatchObject({ privateOutbound: false, pcmSend: false });
    await expect(gated.dial(plan, new AbortController().signal)).rejects.toMatchObject({ code: 'capability_unavailable' });
    expect(inner.dials).toHaveLength(0);
  });
  it('EvidenceGatedCallAdapter dials only when the evidence says production calling is allowed for this build', async () => {
    const inner = new FakeCallAdapter();
    const ok = new EvidenceGatedCallAdapter(inner, () => deriveCapabilities('/x', FP, read(artifact())));
    await ok.dial(plan, new AbortController().signal);
    expect(inner.dials).toHaveLength(1);
    const partial = new EvidenceGatedCallAdapter(new FakeCallAdapter(), () =>
      deriveCapabilities('/x', FP, read(artifact({ gates: { ...Object.fromEntries(GATE_IDS.map((g) => [g, gate()])), 'G0-F': gate('BLOCKED_EXTERNAL') } }))),
    );
    await expect(partial.dial(plan, new AbortController().signal)).rejects.toMatchObject({ code: 'capability_unavailable' });
  });
});

describe('owner-only calling gate (G0-A..C + G0-D5)', () => {
  const plan = {} as ApprovedCallPlan;
  const ownerGates = (over: Record<string, unknown> = {}) => ({ 'G0-A': gate(), 'G0-B': gate(), 'G0-C': gate(), 'G0-D5': gate(), ...over });
  const owner = (gates: Record<string, unknown>) => deriveCapabilities('/x', FP, read(artifact({ gates, localConsentRecognizer: undefined })));

  it('A, B, C and the 5-minute call (all live PASS, this build) allow calls to the OWNER only', () => {
    const c = owner(ownerGates());
    expect(c).toMatchObject({
      privateOutbound: true,
      pcmSend: true,
      pcmReceive: true,
      ownerCallingAllowed: true,
      productionCallingAllowed: false,
      thirdPartyConsentMechanismProven: false,
    });
    expect(c.reasons.join(' ')).toMatch(/G0-D: not recorded/);
  });
  it('the full six gates imply owner calling too', () => {
    expect(deriveCapabilities('/x', FP, read(artifact()))).toMatchObject({ ownerCallingAllowed: true, productionCallingAllowed: true });
  });
  it('without the 5-minute call, or with any weaker gate, owner calling stays off', () => {
    expect(owner({ 'G0-A': gate(), 'G0-B': gate(), 'G0-C': gate() }).ownerCallingAllowed).toBe(false);
    expect(owner(ownerGates({ 'G0-D5': gate('FAIL') })).ownerCallingAllowed).toBe(false);
    expect(owner(ownerGates({ 'G0-D5': gate('BLOCKED_EXTERNAL') })).ownerCallingAllowed).toBe(false);
    expect(owner(ownerGates({ 'G0-C': gate('FAIL') })).ownerCallingAllowed).toBe(false);
    expect(owner(ownerGates({ 'G0-B': gate('FAIL') })).ownerCallingAllowed).toBe(false);
    expect(owner(ownerGates({ 'G0-A': gate('BLOCKED_EXTERNAL') })).ownerCallingAllowed).toBe(false);
  });
  it('mock / synthetic evidence never counts, for any of the owner gates', () => {
    for (const k of ['mock', 'synthetic'] as const)
      for (const id of ['G0-A', 'G0-B', 'G0-C', 'G0-D5']) expect(owner(ownerGates({ [id]: gate('PASS', k) })).ownerCallingAllowed).toBe(false);
  });
  it('spike-produced evidence and evidence for another build never enable owner calling', () => {
    expect(deriveCapabilities('/x', FP, read(artifact({ producedBy: 'spike', gates: ownerGates() }))).ownerCallingAllowed).toBe(false);
    expect(deriveCapabilities('/x', 'c'.repeat(64), read(artifact({ gates: ownerGates() }))).ownerCallingAllowed).toBe(false);
    expect(deriveCapabilities(null, FP).ownerCallingAllowed).toBe(false);
  });
  it('EvidenceGatedCallAdapter: the owner-only evidence lets the OWNER be dialed and refuses anyone else', async () => {
    const derive = () => deriveCapabilities('/x', FP, read(artifact({ gates: ownerGates(), localConsentRecognizer: undefined })));
    const inner = new FakeCallAdapter();
    const gated = new EvidenceGatedCallAdapter(inner, derive, '777000111');
    await gated.dial({ ...plan, recipientTelegramId: '777000111' }, new AbortController().signal);
    expect(inner.dials).toHaveLength(1);
    await expect(gated.dial({ ...plan, recipientTelegramId: '555000222' }, new AbortController().signal)).rejects.toMatchObject({
      code: 'capability_unavailable',
    });
    expect(inner.dials).toHaveLength(1);
    // without the owner id configured nobody counts as the owner
    const strict = new EvidenceGatedCallAdapter(new FakeCallAdapter(), derive);
    await expect(strict.dial({ ...plan, recipientTelegramId: '777000111' }, new AbortController().signal)).rejects.toMatchObject({
      code: 'capability_unavailable',
    });
  });
});
