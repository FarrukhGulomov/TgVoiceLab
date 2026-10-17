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
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

/** A completed, clean, two-way call: the bar for G0-B (set-up and sustained call) before audio is judged. */
export const MIN_CALL_SECONDS = 30;
/** The 5-minute owner call (a little under 300 s tolerates the connect/teardown jitter of a 300 s cap). */
export const MIN_LONG_CALL_SECONDS = 290;
export const MIN_INBOUND_NON_SILENT_FRAMES = 50; // >= 0.5 s of real audio from the person
export const MIN_OUTBOUND_FRAMES = 500; // >= 5 s of AI audio sent

const callOk = (r: RunRecord) =>
  r.recipientIsOwner && r.connected && (r.endedReason === 'completed' || r.endedReason === 'duration_limit') && r.bridgeErrors === 0;
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
  gates: Record<'G0-A' | 'G0-B' | 'G0-C' | typeof OWNER_GATE_ID, GateOut>;
}

/**
 * `records`: parsed run records with the file name each came from. `gateA`: the G0-A login record, already checked by the caller to be
 * a live PASS. Only the owner-only gates are produced; G0-D/E/F are deliberately left out (their absence means "not passed").
 */
export function assembleProductionEvidence(a: {
  records: Array<{ file: string; record: RunRecord }>;
  gateA: { file: string; recordedAt: string } | null;
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
      [OWNER_GATE_ID]: gate(
        mine.filter((r) => twoWay(r.record) && r.record.durationSeconds >= MIN_LONG_CALL_SECONDS),
        `no clean two-way live call of >= ${MIN_LONG_CALL_SECONDS} s for this build`,
      ),
    },
  };
}
