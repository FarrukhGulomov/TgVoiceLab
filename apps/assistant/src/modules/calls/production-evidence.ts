import { z } from 'zod';
import { OWNER_GATE_ID } from './capability-evidence.js';

/**
 * Production-adapter evidence, assembled from run records written by `pnpm live:ai-call` (a LIVE call through NtgcallsCallAdapter to the
 * owner's own number). The gates are decided from measured facts plus one operator attestation, and only runs recorded for THIS build
 * count. Nothing here can produce a PASS from mock/synthetic data: there is no such input, only live run records.
 */
export const RunRecordSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('live'),
  producedBy: z.literal('production-adapter'),
  recordedAt: z.iso.datetime({ offset: true }),
  buildFingerprint: z.string().min(16),
  provider: z.string(),
  recipientIsOwner: z.boolean(),
  connected: z.boolean(),
  durationSeconds: z.number().min(0),
  endedReason: z.string().nullable(),
  callFramesIn: z.number().int().min(0),
  nonSilentFramesIn: z.number().int().min(0),
  callFramesOut: z.number().int().min(0),
  bridgeErrors: z.number().int().min(0),
  /** Operator attestation: did the person on the phone hear the AI clearly? Only a human can say. */
  operatorHeardAiClearly: z.enum(['yes', 'no', 'skipped']),
  /** Who was called: the owner, or a second test account standing in for a contact. Older records only have `recipientIsOwner`. */
  recipientKind: z.enum(['owner', 'test_account']).optional(),
  /** What this run exercised. Default `chat` = an AI conversation. */
  scenario: z.enum(['chat', 'short_batch', 'decline', 'busy', 'no_answer', 'privacy', 'connectivity_loss']).default('chat'),
  /** `short_batch` runs: one id per batch, 1-based index, planned size. */
  batchId: z.string().optional(),
  batchIndex: z.number().int().min(1).optional(),
  batchSize: z.number().int().min(1).optional(),
  /** How many dials this run placed: anything but 1 means a redial happened, which fails every scenario. */
  dialCount: z.number().int().min(0).default(1),
  /** Failure scenarios: the human confirms they really did the action (declined, was busy, restricted calls, cut the network). */
  operatorConfirmedAction: z.enum(['yes', 'no', 'skipped']).default('skipped'),
  /** The dial itself was refused with this reason (e.g. privacy_restricted, busy). */
  dialRejected: z.string().nullable().default(null),
  /** Who ended the call. `tool_failsafe` (the operator tool gave up waiting) never satisfies a scenario. */
  endedBy: z.enum(['adapter', 'ring_timeout', 'tool_failsafe']).default('adapter'),
  bargeIns: z.number().int().min(0).default(0),
  /** The run happened on the intended deployment host/container (operator-declared with LIVE_TEST_HOST_IS_TARGET=yes). */
  hostIsTarget: z.boolean().default(false),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

/** A completed, clean, two-way call: the bar for G0-B (set-up and sustained call) before audio is judged. */
export const MIN_CALL_SECONDS = 30;
/** The 5-minute owner call (a little under 300 s tolerates the connect/teardown jitter of a 300 s cap). */
export const MIN_LONG_CALL_SECONDS = 290;
export const MIN_INBOUND_NON_SILENT_FRAMES = 50; // >= 0.5 s of real audio from the person
export const MIN_OUTBOUND_FRAMES = 500; // >= 5 s of AI audio sent

/** A real person on the other end that the operator controls: the owner, or the second test account standing in for a contact. */
const participant = (r: RunRecord) => r.recipientIsOwner || r.recipientKind === 'test_account';
const cleanCall = (r: RunRecord) =>
  participant(r) && r.connected && (r.endedReason === 'completed' || r.endedReason === 'duration_limit') && r.bridgeErrors === 0 && r.dialCount === 1;
const twoWayAny = (r: RunRecord) =>
  cleanCall(r) &&
  r.durationSeconds >= MIN_CALL_SECONDS &&
  r.operatorHeardAiClearly === 'yes' &&
  r.nonSilentFramesIn >= MIN_INBOUND_NON_SILENT_FRAMES &&
  r.callFramesOut >= MIN_OUTBOUND_FRAMES;

const callOk = (r: RunRecord) => participant(r) && r.connected && (r.endedReason === 'completed' || r.endedReason === 'duration_limit') && r.bridgeErrors === 0;
const twoWay = (r: RunRecord) =>
  callOk(r) &&
  r.durationSeconds >= MIN_CALL_SECONDS &&
  r.operatorHeardAiClearly === 'yes' &&
  r.nonSilentFramesIn >= MIN_INBOUND_NON_SILENT_FRAMES &&
  r.callFramesOut >= MIN_OUTBOUND_FRAMES;

export interface GateOut {
  result: 'PASS' | 'BLOCKED_EXTERNAL';
  kind: 'live';
  recordedAt: string;
  evidenceRefs: string[];
}

export interface AssembledEvidence {
  schemaVersion: 1;
  producedBy: 'production-adapter';
  buildFingerprint: string;
  dependencyPins: Record<string, string>;
  gates: Record<'G0-A' | 'G0-B' | 'G0-C' | typeof OWNER_GATE_ID, GateOut> & Partial<Record<'G0-D' | 'G0-E' | 'G0-F', GateOut>>;
}

/** Short calls that must succeed back-to-back for G0-D. */
export const BATCH_CALLS = 10;
export const MIN_BATCH_CALL_SECONDS = 15;
/** The failure scenarios G0-E needs, each observed live and confirmed by the person who caused it. */
export const E_SCENARIOS = ['decline', 'busy', 'no_answer', 'privacy', 'connectivity_loss'] as const;
/** Duplicate provider events and a process crash cannot be provoked safely on a live account: they are covered by automated tests and listed as SYNTHETIC. */
export const E_SYNTHETIC_REFS = [
  'synthetic:tests/integration/calls-orchestrator.test.ts (duplicate provider events, crash recovery without redial)',
  'synthetic:tests/unit/ntgcalls-adapter.test.ts (duplicate/late updates, no redial)',
] as const;

const scenarioOk = (r: RunRecord, sc: (typeof E_SCENARIOS)[number]): boolean => {
  if (r.scenario !== sc || !participant(r) || r.dialCount !== 1 || r.operatorConfirmedAction !== 'yes' || r.bridgeErrors !== 0) return false;
  switch (sc) {
    case 'decline':
      return !r.connected && ['declined', 'no_answer', 'busy'].includes(r.endedReason ?? '');
    case 'busy':
      return !r.connected && (r.endedReason === 'busy' || r.dialRejected === 'busy');
    case 'no_answer':
      return !r.connected && r.endedReason === 'no_answer' && r.endedBy !== 'tool_failsafe';
    case 'privacy':
      return !r.connected && r.dialRejected === 'privacy_restricted';
    case 'connectivity_loss':
      return r.connected && r.endedReason !== null; // the ADAPTER reported the end by itself (the tool never forces one)
  }
};

/** Ten consecutive short calls: one batch, indices 1..10 all present, each clean, none redialed. */
export function batchPasses(records: RunRecord[]): { ok: boolean; ids: RunRecord[] } {
  const byBatch = new Map<string, RunRecord[]>();
  for (const r of records.filter((x) => x.scenario === 'short_batch' && x.batchId)) byBatch.set(r.batchId!, [...(byBatch.get(r.batchId!) ?? []), r]);
  for (const list of byBatch.values()) {
    const sorted = [...list].sort((a, b) => (a.batchIndex ?? 0) - (b.batchIndex ?? 0));
    const complete = Array.from({ length: BATCH_CALLS }, (_, i) => sorted.find((x) => x.batchIndex === i + 1));
    if (complete.every((x) => x && cleanCall(x) && x.durationSeconds >= MIN_BATCH_CALL_SECONDS && (x.batchSize ?? 0) >= BATCH_CALLS))
      return { ok: true, ids: complete as RunRecord[] };
  }
  return { ok: false, ids: [] };
}

/**
 * `records`: parsed run records with the file name each came from. `gateA`: the G0-A login record, already checked by the caller to be
 * a live PASS. Only the owner-only gates are produced; G0-D/E/F are deliberately left out (their absence means "not passed").
 */
export function assembleProductionEvidence(a: {
  records: Array<{ file: string; record: RunRecord }>;
  gateA: { file: string; recordedAt: string } | null;
  /** Operator attestation of the target host and the phone clients used (G0-F), already validated for this build. */
  gateF?: { file: string; recordedAt: string } | null;
  fingerprint: string;
  pins: Record<string, string>;
  now: Date;
}): AssembledEvidence {
  const mine = a.records.filter((r) => r.record.buildFingerprint === a.fingerprint);
  const gate = (pass: Array<{ file: string; record: RunRecord }>, missing: string): GateOut =>
    pass.length
      ? { result: 'PASS', kind: 'live', recordedAt: pass[pass.length - 1]!.record.recordedAt, evidenceRefs: pass.map((p) => p.file) }
      : { result: 'BLOCKED_EXTERNAL', kind: 'live', recordedAt: a.now.toISOString(), evidenceRefs: [missing] };
  return {
    schemaVersion: 1,
    producedBy: 'production-adapter',
    buildFingerprint: a.fingerprint,
    dependencyPins: a.pins,
    gates: {
      'G0-A': a.gateA
        ? { result: 'PASS', kind: 'live', recordedAt: a.gateA.recordedAt, evidenceRefs: [a.gateA.file] }
        : { result: 'BLOCKED_EXTERNAL', kind: 'live', recordedAt: a.now.toISOString(), evidenceRefs: ['no G0-A login record'] },
      'G0-B': gate(
        mine.filter((r) => callOk(r.record) && r.record.durationSeconds >= MIN_CALL_SECONDS),
        `no completed live call of >= ${MIN_CALL_SECONDS} s for this build`,
      ),
      'G0-C': gate(
        mine.filter((r) => twoWay(r.record)),
        'no live call for this build with audio heard clearly by the operator and non-silent audio from the person',
      ),
      ...fullGates(a, mine),
      [OWNER_GATE_ID]: gate(
        mine.filter((r) => r.record.recipientIsOwner && twoWay(r.record) && r.record.durationSeconds >= MIN_LONG_CALL_SECONDS),
        `no clean two-way live call of >= ${MIN_LONG_CALL_SECONDS} s for this build`,
      ),
    },
  };
}

function fullGates(
  a: { records: Array<{ file: string; record: RunRecord }>; gateF?: { file: string; recordedAt: string } | null; now: Date },
  mine: Array<{ file: string; record: RunRecord }>,
): Partial<Record<'G0-D' | 'G0-E' | 'G0-F', GateOut>> {
  const out: Partial<Record<'G0-D' | 'G0-E' | 'G0-F', GateOut>> = {};
  const recs = mine.map((m) => m.record);
  const fileOf = (r: RunRecord) => mine.find((m) => m.record === r)!.file;
  const last = (rs: RunRecord[]) =>
    rs
      .map((r) => r.recordedAt)
      .sort()
      .at(-1) ?? a.now.toISOString();

  // G0-D: a sustained 5-minute two-way call with a real interruption, AND ten consecutive short successful calls.
  const long = recs.filter((r) => twoWayAny(r) && r.durationSeconds >= MIN_LONG_CALL_SECONDS && r.bargeIns >= 1);
  const batch = batchPasses(recs);
  if (long.length && batch.ok)
    out['G0-D'] = { result: 'PASS', kind: 'live', recordedAt: last([...long, ...batch.ids]), evidenceRefs: [...long, ...batch.ids].map(fileOf) };
  else
    out['G0-D'] = {
      result: 'BLOCKED_EXTERNAL',
      kind: 'live',
      recordedAt: a.now.toISOString(),
      evidenceRefs: [
        `need ${long.length ? '' : `a >= ${MIN_LONG_CALL_SECONDS} s two-way call with a barge-in; `}${batch.ok ? '' : `${BATCH_CALLS} consecutive clean short calls (scenario short_batch)`}`.trim(),
      ],
    };

  // G0-E: every failure scenario observed live, confirmed by the human who caused it.
  const found = E_SCENARIOS.map((sc) => ({ sc, rec: recs.find((r) => scenarioOk(r, sc)) }));
  const missing = found.filter((f) => !f.rec).map((f) => f.sc);
  if (!missing.length)
    out['G0-E'] = {
      result: 'PASS',
      kind: 'live',
      recordedAt: last(found.map((f) => f.rec!)),
      evidenceRefs: [...found.map((f) => fileOf(f.rec!)), ...E_SYNTHETIC_REFS],
    };
  else
    out['G0-E'] = {
      result: 'BLOCKED_EXTERNAL',
      kind: 'live',
      recordedAt: a.now.toISOString(),
      evidenceRefs: [`missing live scenarios: ${missing.join(', ')}`],
    };

  // G0-F: a clean two-way run on the intended host/container plus the operator's attestation of host and phone clients.
  const onTarget = recs.filter((r) => twoWayAny(r) && r.hostIsTarget);
  if (onTarget.length && a.gateF)
    out['G0-F'] = { result: 'PASS', kind: 'live', recordedAt: last(onTarget), evidenceRefs: [...onTarget.map(fileOf), a.gateF.file] };
  else
    out['G0-F'] = {
      result: 'BLOCKED_EXTERNAL',
      kind: 'live',
      recordedAt: a.now.toISOString(),
      evidenceRefs: [
        `need ${onTarget.length ? '' : 'a clean two-way run on the target host (LIVE_TEST_HOST_IS_TARGET=yes); '}${a.gateF ? '' : 'the G0-F attestation file for this build'}`.trim(),
      ],
    };
  return out;
}
