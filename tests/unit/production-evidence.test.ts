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
  scenario: 'chat',
  dialCount: 1,
  operatorConfirmedAction: 'skipped',
  dialRejected: null,
  bargeIns: 0,
  hostIsTarget: false,
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
const results = (a: ReturnType<typeof assemble>) =>
  Object.fromEntries(
    Object.entries(a.gates)
      .filter(([k]) => !['G0-D', 'G0-E', 'G0-F'].includes(k))
      .map(([k, g]) => [k, g!.result]),
  );
const all = (a: ReturnType<typeof assemble>) => Object.fromEntries(Object.entries(a.gates).map(([k, g]) => [k, g!.result]));

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

  it('owner-call records alone never enable contact calls: G0-D/E/F stay blocked', () => {
    const a = assemble([run()]);
    expect(all(a)).toMatchObject({ 'G0-D': 'BLOCKED_EXTERNAL', 'G0-E': 'BLOCKED_EXTERNAL', 'G0-F': 'BLOCKED_EXTERNAL' });
    expect(derive(a).productionCallingAllowed).toBe(false);
  });

  it('run records must be live production-adapter records', () => {
    expect(RunRecordSchema.safeParse(run()).success).toBe(true);
    expect(RunRecordSchema.safeParse({ ...run(), producedBy: 'spike' }).success).toBe(false);
    expect(RunRecordSchema.safeParse({ ...run(), kind: 'mock' }).success).toBe(false);
    expect(RunRecordSchema.safeParse({ ...run(), operatorHeardAiClearly: 'maybe' }).success).toBe(false);
  });
});

describe('contact-calling gates G0-D / G0-E / G0-F (test account standing in for a contact)', () => {
  const tester = (over: Partial<RunRecord> = {}) => run({ recipientIsOwner: false, recipientKind: 'test_account', ...over });
  const short = (i: number, over: Partial<RunRecord> = {}) =>
    tester({
      scenario: 'short_batch',
      batchId: 'b1',
      batchIndex: i,
      batchSize: 10,
      durationSeconds: 20,
      endedReason: 'completed',
      operatorHeardAiClearly: 'skipped',
      recordedAt: `2026-10-17T06:${10 + i}:00.000Z`,
      ...over,
    });
  const batch = (n = 10, over: Partial<RunRecord> = {}) => Array.from({ length: n }, (_, i) => short(i + 1, over));
  const long = () => tester({ durationSeconds: 300, bargeIns: 3 });
  const failing = (scenario: RunRecord['scenario'], over: Partial<RunRecord>) =>
    tester({
      scenario,
      connected: false,
      durationSeconds: 0,
      endedReason: null,
      operatorConfirmedAction: 'yes',
      operatorHeardAiClearly: 'skipped',
      callFramesIn: 0,
      nonSilentFramesIn: 0,
      callFramesOut: 0,
      ...over,
    });
  const eRuns = () => [
    failing('decline', { endedReason: 'declined' }),
    failing('busy', { endedReason: 'busy' }),
    failing('no_answer', { endedReason: 'no_answer' }),
    failing('privacy', { dialRejected: 'privacy_restricted' }),
    tester({
      scenario: 'connectivity_loss',
      durationSeconds: 70,
      endedReason: 'transport_error',
      operatorConfirmedAction: 'yes',
      operatorHeardAiClearly: 'skipped',
    }),
  ];
  const F = { file: 'G0-F.local.json', recordedAt: '2026-10-17T06:59:00.000Z' };
  const full = (extra: RunRecord[] = [], gateF: typeof F | null = F) =>
    assembleProductionEvidence({
      records: [
        ...[run(), long(), ...batch(), ...eRuns(), tester({ hostIsTarget: true })].concat(extra).map((record, i) => ({ file: `PA-${i}.local.json`, record })),
      ],
      gateA: A,
      gateF,
      fingerprint: FP,
      pins: { ntgcalls: '3.0.3' },
      now: NOW,
    });

  it('everything recorded live for this build passes all six gates, and the application then allows contact calls', () => {
    const a = full();
    expect(all(a)).toEqual({ 'G0-A': 'PASS', 'G0-B': 'PASS', 'G0-C': 'PASS', 'G0-D5': 'PASS', 'G0-D': 'PASS', 'G0-E': 'PASS', 'G0-F': 'PASS' });
    expect(a.gates['G0-E']!.evidenceRefs.some((r) => r.startsWith('synthetic:'))).toBe(true); // the synthetic coverage is labelled as such
    expect(derive(a)).toMatchObject({ productionCallingAllowed: true, ownerCallingAllowed: true });
  });

  it('nothing is invented: without any of those records the gates stay blocked', () => {
    expect(all(assemble([run()]))).toMatchObject({ 'G0-D': 'BLOCKED_EXTERNAL', 'G0-E': 'BLOCKED_EXTERNAL', 'G0-F': 'BLOCKED_EXTERNAL' });
    expect(derive(assemble([run()])).productionCallingAllowed).toBe(false);
  });

  it('G0-D needs ten consecutive clean short calls AND a 5-minute call with a real interruption', () => {
    const mk = (recs: RunRecord[]) => assemble(recs);
    expect(all(mk([long(), ...batch()]))['G0-D']).toBe('PASS');
    expect(all(mk([long(), ...batch(9)]))['G0-D']).toBe('BLOCKED_EXTERNAL'); // only nine
    expect(all(mk([long(), ...batch(10).map((r, i) => (i === 4 ? { ...r, endedReason: 'transport_error' } : r))]))['G0-D']).toBe('BLOCKED_EXTERNAL'); // one not clean
    expect(all(mk([long(), ...batch(10).map((r, i) => (i === 4 ? { ...r, dialCount: 2 } : r))]))['G0-D']).toBe('BLOCKED_EXTERNAL'); // a redial
    expect(all(mk([tester({ durationSeconds: 300, bargeIns: 0 }), ...batch()]))['G0-D']).toBe('BLOCKED_EXTERNAL'); // no interruption
    expect(all(mk([long()]))['G0-D']).toBe('BLOCKED_EXTERNAL');
  });

  it('G0-E needs every failure scenario, confirmed by the person; a forced hang-up or an unconfirmed action does not count', () => {
    expect(all(assemble(eRuns()))['G0-E']).toBe('PASS');
    for (const i of [0, 1, 2, 3, 4]) expect(all(assemble(eRuns().filter((_, j) => j !== i)))['G0-E']).toBe('BLOCKED_EXTERNAL');
    expect(all(assemble(eRuns().map((r) => ({ ...r, operatorConfirmedAction: 'no' as const }))))['G0-E']).toBe('BLOCKED_EXTERNAL');
    expect(all(assemble(eRuns().map((r, i) => (i === 4 ? { ...r, endedReason: null } : r))))['G0-E']).toBe('BLOCKED_EXTERNAL'); // adapter never reported the end
    expect(all(assemble(eRuns().map((r, i) => (i === 2 ? { ...r, dialCount: 2 } : r))))['G0-E']).toBe('BLOCKED_EXTERNAL'); // redial
  });

  it('G0-F needs a clean two-way run on the target host AND the operator attestation for this build', () => {
    expect(all(full([], null))['G0-F']).toBe('BLOCKED_EXTERNAL');
    const noHost = assembleProductionEvidence({
      records: [long()].map((record) => ({ file: 'p.json', record })),
      gateA: A,
      gateF: F,
      fingerprint: FP,
      pins: {},
      now: NOW,
    });
    expect(all(noHost)['G0-F']).toBe('BLOCKED_EXTERNAL');
  });

  it('records for another build never count', () => {
    const other = (r: RunRecord): RunRecord => ({ ...r, buildFingerprint: 'e'.repeat(64) });
    const a = assembleProductionEvidence({
      records: [long(), ...batch(), ...eRuns(), tester({ hostIsTarget: true })].map((r, i) => ({ file: `PA-${i}`, record: other(r) })),
      gateA: A,
      gateF: F,
      fingerprint: FP,
      pins: {},
      now: NOW,
    });
    expect(all(a)).toMatchObject({ 'G0-D': 'BLOCKED_EXTERNAL', 'G0-E': 'BLOCKED_EXTERNAL', 'G0-F': 'BLOCKED_EXTERNAL' });
  });

  it('the schema accepts old run records (no new fields) with safe defaults', () => {
    const old = {
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
      callFramesIn: 1,
      nonSilentFramesIn: 1,
      callFramesOut: 1,
      bridgeErrors: 0,
      operatorHeardAiClearly: 'yes',
    };
    expect(RunRecordSchema.parse(old)).toMatchObject({ scenario: 'chat', dialCount: 1, operatorConfirmedAction: 'skipped', hostIsTarget: false, bargeIns: 0 });
  });
});
