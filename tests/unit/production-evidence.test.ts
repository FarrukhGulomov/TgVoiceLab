import { describe, expect, it } from 'vitest';
import { assembleProductionEvidence, RunRecordSchema, type RunRecord } from '../../apps/assistant/src/modules/calls/production-evidence.js';
import { deriveCapabilities } from '../../apps/assistant/src/modules/calls/capability-evidence.js';

const FP = 'f'.repeat(64);
const NOW = new Date('2026-10-17T07:00:00Z');
const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  schemaVersion: 1,
  kind: 'live',
  producedBy: 'production-adapter',
  recordedAt: '2026-10-17T06:50:00.000Z',
  buildFingerprint: FP,
  provider: 'gemini',
  recipientIsOwner: true,
  connected: true,
  durationSeconds: 300,
  endedReason: 'duration_limit',
  callFramesIn: 28000,
  nonSilentFramesIn: 4000,
  callFramesOut: 14000,
  bridgeErrors: 0,
  operatorHeardAiClearly: 'yes',
  ...over,
});
const A = { file: 'G0-A.local.json', recordedAt: '2026-10-17T05:00:00.000Z' };
const assemble = (runs: RunRecord[], gateA: typeof A | null = A, fp = FP) =>
  assembleProductionEvidence({
    records: runs.map((record, i) => ({ file: `PA-${i}.local.json`, record })),
    gateA,
    fingerprint: fp,
    pins: { ntgcalls: '3.0.3' },
    now: NOW,
  });
const derive = (a: ReturnType<typeof assemble>, fp = FP) => deriveCapabilities('/x', fp, () => JSON.stringify(a));
const results = (a: ReturnType<typeof assemble>) => Object.fromEntries(Object.entries(a.gates).map(([k, g]) => [k, g.result]));

describe('production evidence assembly (owner-only gates)', () => {
  it('a clean 5-minute two-way owner call for this build passes A, B, C and G0-D5, and the application derives owner calling from it', () => {
    const a = assemble([run()]);
    expect(results(a)).toEqual({ 'G0-A': 'PASS', 'G0-B': 'PASS', 'G0-C': 'PASS', 'G0-D5': 'PASS' });
    expect(a.gates['G0-D5'].evidenceRefs).toEqual(['PA-0.local.json']);
    const caps = derive(a);
    expect(caps).toMatchObject({ ownerCallingAllowed: true, productionCallingAllowed: false, thirdPartyConsentMechanismProven: false });
  });

  it('a shorter call proves B and C but not the 5-minute gate', () => {
    const a = assemble([run({ durationSeconds: 120, endedReason: 'completed' })]);
    expect(results(a)).toEqual({ 'G0-A': 'PASS', 'G0-B': 'PASS', 'G0-C': 'PASS', 'G0-D5': 'BLOCKED_EXTERNAL' });
    expect(derive(a).ownerCallingAllowed).toBe(false);
    expect(derive(assemble([run({ durationSeconds: 289 })])).ownerCallingAllowed).toBe(false);
  });

  it.each([
    ['another build', { buildFingerprint: 'e'.repeat(64) }],
    ['a call to someone who is not the owner', { recipientIsOwner: false }],
    ['the operator did not hear the AI clearly', { operatorHeardAiClearly: 'no' as const }],
    ['the operator was not asked', { operatorHeardAiClearly: 'skipped' as const }],
    ['no audio from the person (silence)', { nonSilentFramesIn: 3 }],
    ['almost no AI audio sent', { callFramesOut: 100 }],
    ['bridge/provider errors during the call', { bridgeErrors: 1 }],
    ['the call failed', { endedReason: 'transport_error' }],
    ['never connected', { connected: false, durationSeconds: 0 }],
  ])('does not pass when %s', (_name, over) => {
    const a = assemble([run(over as Partial<RunRecord>)]);
    expect(derive(a).ownerCallingAllowed).toBe(false);
    expect(a.gates['G0-D5'].result).toBe('BLOCKED_EXTERNAL');
  });

  it('without the G0-A login record nothing is allowed', () => {
    const a = assemble([run()], null);
    expect(a.gates['G0-A'].result).toBe('BLOCKED_EXTERNAL');
    expect(derive(a).ownerCallingAllowed).toBe(false);
  });

  it('records for an older build are ignored, so changed code needs a fresh long call', () => {
    const old = run({ buildFingerprint: 'a'.repeat(64) });
    expect(derive(assemble([old])).ownerCallingAllowed).toBe(false);
    expect(derive(assemble([old, run()])).ownerCallingAllowed).toBe(true);
  });

  it('the artifact cannot be used for a different fingerprint than the one it was assembled for', () => {
    expect(derive(assemble([run()]), 'd'.repeat(64)).ownerCallingAllowed).toBe(false);
  });

  it('the evidence never enables contact calls: G0-D/E/F are never produced', () => {
    const a = assemble([run()]);
    expect(Object.keys(a.gates)).toEqual(['G0-A', 'G0-B', 'G0-C', 'G0-D5']);
    expect(derive(a).productionCallingAllowed).toBe(false);
  });

  it('run records must be live production-adapter records', () => {
    expect(RunRecordSchema.safeParse(run()).success).toBe(true);
    expect(RunRecordSchema.safeParse({ ...run(), producedBy: 'spike' }).success).toBe(false);
    expect(RunRecordSchema.safeParse({ ...run(), kind: 'mock' }).success).toBe(false);
    expect(RunRecordSchema.safeParse({ ...run(), operatorHeardAiClearly: 'maybe' }).success).toBe(false);
  });
});
