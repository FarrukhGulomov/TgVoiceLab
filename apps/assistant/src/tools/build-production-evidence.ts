/**
 * Assemble the production-adapter evidence artifact from the live run records written by `pnpm live:ai-call`.
 *   pnpm evidence:production
 * Writes experiments/telegram-calls/evidence/production.local.json (not committed). Point CALL_FEASIBILITY_EVIDENCE_PATH at it.
 * The artifact is bound to the current build fingerprint: after any change to the call path (see FINGERPRINT_DIRS) or the lockfile,
 * old run records no longer count and the long call must be recorded again.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeBuildFingerprint, deriveCapabilities } from '../modules/calls/capability-evidence.js';
import { RunRecordSchema, assembleProductionEvidence, type RunRecord } from '../modules/calls/production-evidence.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const DIR = join(ROOT, 'experiments/telegram-calls/evidence');
mkdirSync(DIR, { recursive: true });

const fingerprint = computeBuildFingerprint(ROOT);
const records: Array<{ file: string; record: RunRecord }> = [];
let ignored = 0;
for (const f of readdirSync(DIR)
  .filter((n) => /^PA-.*\.local\.json$/.test(n))
  .sort()) {
  const parsed = RunRecordSchema.safeParse(JSON.parse(readFileSync(join(DIR, f), 'utf8')));
  if (parsed.success) records.push({ file: `experiments/telegram-calls/evidence/${f}`, record: parsed.data });
  else ignored++;
}

let gateA: { file: string; recordedAt: string } | null = null;
try {
  const a = JSON.parse(readFileSync(join(DIR, 'G0-A.local.json'), 'utf8')) as { kind?: string; result?: string; recordedAt?: string };
  if (a.kind === 'live' && a.result === 'PASS' && a.recordedAt)
    gateA = { file: 'experiments/telegram-calls/evidence/G0-A.local.json', recordedAt: a.recordedAt };
} catch {
  /* no login record */
}

let gateF: { file: string; recordedAt: string } | null = null;
try {
  const f = JSON.parse(readFileSync(join(DIR, 'G0-F.local.json'), 'utf8')) as {
    kind?: string;
    result?: string;
    recordedAt?: string;
    buildFingerprint?: string;
    phoneClients?: string[];
  };
  if (f.kind === 'live' && f.result === 'PASS' && f.recordedAt && f.buildFingerprint === fingerprint && f.phoneClients?.length)
    gateF = { file: 'experiments/telegram-calls/evidence/G0-F.local.json', recordedAt: f.recordedAt };
} catch {
  /* no attestation */
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'apps/assistant/package.json'), 'utf8')) as { dependencies: Record<string, string> };
const pins = Object.fromEntries(['ntgcalls', 'telegram', 'ws'].map((k) => [k, pkg.dependencies[k] ?? 'unknown']));
const artifact = assembleProductionEvidence({ records, gateA, gateF, fingerprint, pins, now: new Date() });
const out = join(DIR, 'production.local.json');
writeFileSync(out, JSON.stringify(artifact, null, 2));

const caps = deriveCapabilities(out, fingerprint);
console.log(`build fingerprint: ${fingerprint}`);
console.log(
  `run records: ${records.length} usable (${records.filter((r) => r.record.buildFingerprint === fingerprint).length} for this build), ${ignored} ignored (invalid)`,
);
for (const [id, g] of Object.entries(artifact.gates)) console.log(`  ${id}: ${g.result}${g.result === 'PASS' ? '' : `  — ${g.evidenceRefs[0]}`}`);
console.log(`written: ${out}`);
console.log(`owner calling allowed for this build: ${caps.ownerCallingAllowed ? 'YES' : 'NO'}${caps.ownerCallingAllowed ? '' : ` (${caps.reasons.at(-1)})`}`);
console.log(
  `contact calls (all six gates) allowed for this build: ${caps.productionCallingAllowed ? 'YES' : 'NO'}${caps.productionCallingAllowed ? '' : ' — see the G0-D / G0-E / G0-F lines above'}`,
);
console.log(`\nTo use it: BUILD_FINGERPRINT=${fingerprint}  CALL_FEASIBILITY_EVIDENCE_PATH=${out}`);
