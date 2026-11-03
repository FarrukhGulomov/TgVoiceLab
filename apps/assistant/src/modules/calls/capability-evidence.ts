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
/**
 * Owner-only calling gate (owner decision 2026-10-17): one live 5-minute two-way call to the owner's own number with the PRODUCTION adapter.
 * With G0-A..C it allows calls TO THE OWNER only. Calls to anyone else still need all six full gates (and, for AI processing, the consent recognizer).
 */
export const OWNER_GATE_ID = 'G0-D5' as const;
export const EvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  /**
   * Who produced the live runs. Evidence from the Phase 0 SPIKE ('spike') proves the library/approach is feasible but can
   * never enable production: only a live run of the production adapter itself ('production-adapter') can.
   */
  producedBy: z.literal('production-adapter'),
  buildFingerprint: z.string().min(16),
  dependencyPins: z.record(z.string(), z.string()),
  gates: z.object({
    'G0-A': Gate,
    'G0-B': Gate,
    'G0-C': Gate,
    // Optional: an owner-only deployment records only A, B, C and G0-D5. A missing gate counts as not passed.
    'G0-D': Gate.optional(),
    'G0-E': Gate.optional(),
    'G0-F': Gate.optional(),
    'G0-D5': Gate.optional(),
  }),
  /** Third-party AI-processing consent requires a verified local consent recognizer (spec §2.3). */
  localConsentRecognizer: Gate.optional(),
});
export type CapabilityEvidence = z.infer<typeof EvidenceSchema>;

export interface DerivedCapabilities extends CallAdapterCapabilities {
  /** True only when every Phase 0 gate G0-A..G0-F is a live PASS for this exact build. Required for calls to anyone but the owner. */
  productionCallingAllowed: boolean;
  /** Calls TO THE OWNER: G0-A..C plus the 5-minute G0-D5 (or the full set), all live PASS for this exact build. */
  ownerCallingAllowed: boolean;
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
  ownerCallingAllowed: false,
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
    if (!g) reasons.push(`${id}: not recorded`);
    else if (!livePass(g)) reasons.push(`${id}: ${g.result}${g.kind !== 'live' ? ` (${g.kind} evidence cannot pass a real-media gate)` : ''}`);
  }
  const g = ev.gates;
  const signaling = livePass(g['G0-A']) && livePass(g['G0-B']);
  const media = signaling && livePass(g['G0-C']);
  const productionCallingAllowed = GATE_IDS.every((id) => livePass(g[id]));
  const ownerCallingAllowed = media && (livePass(g[OWNER_GATE_ID]) || productionCallingAllowed);
  if (!ownerCallingAllowed) reasons.push(`owner calls: need G0-A, G0-B, G0-C and ${OWNER_GATE_ID} as live PASS for this build`);
  return {
    privateOutbound: signaling,
    privateInbound: false,
    pcmSend: media,
    pcmReceive: media,
    evidenceArtifact: evidencePath,
    buildFingerprint: currentFingerprint,
    productionCallingAllowed,
    ownerCallingAllowed,
    thirdPartyConsentMechanismProven: livePass(ev.localConsentRecognizer),
    reasons,
  };
}

/**
 * Directories whose source defines what the evidence was recorded against and what a call can do or cost: the Telegram gateway and media path,
 * the AI/voice providers, the orchestrator, adapter, audio bridge and conversation runners (all of modules/calls), the dial policy,
 * live-call control and the contracts. A change in any of them means the evidence no longer describes the running code (audit F-14).
 */
export const FINGERPRINT_DIRS = [
  // transport and media
  'apps/assistant/src/infrastructure/telegram',
  'apps/assistant/src/infrastructure/audio',
  // the AI / voice providers a call talks through
  'apps/assistant/src/infrastructure/openai',
  'apps/assistant/src/infrastructure/gemini',
  'apps/assistant/src/infrastructure/voicelab',
  'apps/assistant/src/infrastructure/elevenlabs',
  // orchestration, adapter, audio bridge and the conversation runners (everything under modules/calls), the dial policy and live-call control
  'apps/assistant/src/modules/calls',
  'apps/assistant/src/modules/policy',
  'apps/assistant/src/modules/operations',
  'packages/contracts/src',
] as const;

/** Deployment fingerprint: lockfile + the call-path sources. Evidence recorded for other code/deps does not transfer. */
export function computeBuildFingerprint(repoRoot: string): string {
  const h = createHash('sha256');
  h.update(readFileSync(join(repoRoot, 'pnpm-lock.yaml')));
  const walk = (d: string): string[] =>
    readdirSync(d)
      .sort()
      .flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  for (const rel of FINGERPRINT_DIRS) {
    try {
      for (const f of walk(join(repoRoot, rel))) h.update(f.slice(repoRoot.length)).update(readFileSync(f));
    } catch {
      /* directory absent in this build */
    }
  }
  return h.digest('hex');
}
