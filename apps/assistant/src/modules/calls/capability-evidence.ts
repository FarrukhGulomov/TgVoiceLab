import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { CallAdapterCapabilities } from '@tgvl/contracts';

/**
 * Feasibility evidence artifact (spec §3.3/§5). Capabilities are DERIVED from it and bound to the deployed build
 * fingerprint; a configuration boolean cannot create a capability. Mock/synthetic results can never pass a gate.
 */
const Gate = z.object({
  result: z.enum(['PASS', 'FAIL', 'BLOCKED_EXTERNAL']),
  kind: z.enum(['live', 'synthetic', 'mock']),
  recordedAt: z.iso.datetime({ offset: true }),
  evidenceRefs: z.array(z.string().min(1)).min(1),
});
export const GATE_IDS = ['G0-A', 'G0-B', 'G0-C', 'G0-D', 'G0-E', 'G0-F'] as const;
export const EvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  /**
   * Who produced the live runs. Evidence from the Phase 0 SPIKE ('spike') proves the library/approach is feasible but can
   * never enable production: only a live run of the production adapter itself ('production-adapter') can.
   */
  producedBy: z.literal('production-adapter'),
  buildFingerprint: z.string().min(16),
  dependencyPins: z.record(z.string(), z.string()),
  gates: z.object({ 'G0-A': Gate, 'G0-B': Gate, 'G0-C': Gate, 'G0-D': Gate, 'G0-E': Gate, 'G0-F': Gate }),
  /** Third-party AI-processing consent requires a verified local consent recognizer (spec §2.3). */
  localConsentRecognizer: Gate.optional(),
});
export type CapabilityEvidence = z.infer<typeof EvidenceSchema>;

export interface DerivedCapabilities extends CallAdapterCapabilities {
  /** True only when every Phase 0 gate G0-A..G0-F is a live PASS for this exact build. */
  productionCallingAllowed: boolean;
  /** True only with a live-verified local consent recognizer. Otherwise third-party calls stay disabled. */
  thirdPartyConsentMechanismProven: boolean;
  reasons: string[];
}

const NONE = (fp: string, reasons: string[]): DerivedCapabilities => ({
  privateOutbound: false,
  privateInbound: false,
  pcmSend: false,
  pcmReceive: false,
  evidenceArtifact: null,
  buildFingerprint: fp,
  productionCallingAllowed: false,
  thirdPartyConsentMechanismProven: false,
  reasons,
});

const livePass = (g: { result: string; kind: string } | undefined) => !!g && g.result === 'PASS' && g.kind === 'live';

export function deriveCapabilities(
  evidencePath: string | null | undefined,
  currentFingerprint: string,
  read: (p: string) => string = (p) => readFileSync(p, 'utf8'),
): DerivedCapabilities {
  if (!evidencePath) return NONE(currentFingerprint, ['no feasibility evidence artifact configured']);
  let raw: unknown;
  try {
    raw = JSON.parse(read(evidencePath));
  } catch {
    return NONE(currentFingerprint, ['evidence artifact unreadable or not JSON']);
  }
  const parsed = EvidenceSchema.safeParse(raw);
  if (!parsed.success) return NONE(currentFingerprint, ['evidence artifact failed schema validation']);
  const ev = parsed.data;
  if (ev.buildFingerprint !== currentFingerprint) return NONE(currentFingerprint, ['evidence is bound to a different build fingerprint']);

  const reasons: string[] = [];
  for (const id of GATE_IDS) {
    const g = ev.gates[id];
    if (!livePass(g)) reasons.push(`${id}: ${g.result}${g.kind !== 'live' ? ` (${g.kind} evidence cannot pass a real-media gate)` : ''}`);
  }
  const g = ev.gates;
  const signaling = livePass(g['G0-A']) && livePass(g['G0-B']);
  const media = signaling && livePass(g['G0-C']);
  return {
    privateOutbound: signaling,
    privateInbound: false,
    pcmSend: media,
    pcmReceive: media,
    evidenceArtifact: evidencePath,
    buildFingerprint: currentFingerprint,
    productionCallingAllowed: GATE_IDS.every((id) => livePass(g[id])),
    thirdPartyConsentMechanismProven: livePass(ev.localConsentRecognizer),
    reasons,
  };
}

/** Deployment fingerprint: lockfile + the gateway adapter sources. Evidence recorded for other code/deps does not transfer. */
export function computeBuildFingerprint(repoRoot: string): string {
  const h = createHash('sha256');
  h.update(readFileSync(join(repoRoot, 'pnpm-lock.yaml')));
  const dir = join(repoRoot, 'apps/assistant/src/infrastructure/telegram');
  const walk = (d: string): string[] =>
    readdirSync(d)
      .sort()
      .flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  try {
    for (const f of walk(dir)) h.update(f.slice(repoRoot.length)).update(readFileSync(f));
  } catch {
    /* adapter directory absent in this build */
  }
  return h.digest('hex');
}
