// Assembles evidence/feasibility-evidence.local.json from the per-gate *.local.json records. Gates with no live record are
// BLOCKED_EXTERNAL. The artifact is stamped producedBy:"spike", which the application REJECTS: spike evidence documents feasibility
// but cannot enable production calling. Only a live run of the production adapter (producedBy:"production-adapter") can.
import { readdirSync } from 'node:fs';
import { computeBuildFingerprint } from '../../scripts/build-fingerprint.mjs';
import { EVIDENCE_DIR, pins, readEvidence, ROOT, writeEvidence } from './lib.mjs';

const GATES = ['G0-A', 'G0-B', 'G0-C', 'G0-D', 'G0-E', 'G0-F'];
const gates = {};
const live = readdirSync(EVIDENCE_DIR)
  .filter((f) => f.startsWith('G0-live-') && f.endsWith('.local.json'))
  .map((f) => ({ f, d: readEvidence(f) }));
for (const g of GATES) {
  const rec = readEvidence(`${g}.local.json`);
  if (rec && rec.kind === 'live') {
    gates[g] = {
      result: rec.result,
      kind: 'live',
      recordedAt: rec.recordedAt,
      evidenceRefs: rec.evidenceRefs ?? [`experiments/telegram-calls/evidence/${g}.local.json`],
    };
    continue;
  }
  const fromRuns = live.filter(({ d }) => d.summary && (g === 'G0-B' || g === 'G0-C') && d.summary[g] === 'PASS');
  if (fromRuns.length) {
    gates[g] = {
      result: 'PASS',
      kind: 'live',
      recordedAt: fromRuns[0].d.recordedAt,
      evidenceRefs: fromRuns.map((x) => `experiments/telegram-calls/evidence/${x.f}`),
    };
    continue;
  }
  gates[g] = { result: 'BLOCKED_EXTERNAL', kind: 'live', recordedAt: new Date().toISOString(), evidenceRefs: ['no live run recorded for this gate'] };
}
const artifact = { schemaVersion: 1, producedBy: 'spike', buildFingerprint: computeBuildFingerprint(ROOT), dependencyPins: pins(), gates };
const p = writeEvidence('feasibility-evidence.local.json', artifact);
console.log(JSON.stringify(Object.fromEntries(GATES.map((g) => [g, gates[g].result])), null, 2));
console.log(`wrote ${p}  (producedBy=spike: documents feasibility only; it cannot enable production calling)`);
