// Records a gate result that cannot be produced by a script (e.g. G0-F: build + run on the TARGET host/container with relevant phone
// clients, G0-E crash/connectivity cases). It is an explicit operator attestation and requires an existing evidence file to point at.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { blocked, pins, ROOT, writeEvidence } from './lib.mjs';

const [gate, result, evidencePath] = process.argv.slice(2);
const problems = [];
if (!['G0-A', 'G0-B', 'G0-C', 'G0-D', 'G0-E', 'G0-F', 'CONSENT'].includes(gate ?? ''))
  problems.push('usage: record-gate <G0-A..G0-F|CONSENT> <PASS|FAIL|BLOCKED_EXTERNAL> <path-to-evidence-file>');
if (!['PASS', 'FAIL', 'BLOCKED_EXTERNAL'].includes(result ?? '')) problems.push('result must be PASS, FAIL or BLOCKED_EXTERNAL');
if (!evidencePath || !existsSync(resolve(ROOT, evidencePath)))
  problems.push('an existing evidence file path (relative to the repo root) is required — a bare assertion is not evidence');
if (result === 'PASS' && process.env.OPERATOR_ATTESTS_LIVE !== 'yes')
  problems.push('PASS requires OPERATOR_ATTESTS_LIVE=yes (you observed this on real devices/host; mock or synthetic runs must not be recorded as PASS)');
if (problems.length) blocked(problems);
const name = `${gate}.local.json`;
const p = writeEvidence(name, {
  gate,
  kind: 'live',
  result,
  recordedAt: new Date().toISOString(),
  pins: pins(),
  evidenceRefs: [evidencePath],
  attestedBy: 'operator',
});
console.log(`recorded ${gate}=${result} → ${p}`);
