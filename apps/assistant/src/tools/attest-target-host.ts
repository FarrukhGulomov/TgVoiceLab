/**
 * G0-F operator attestation: the pinned build runs on the intended Linux host/container and the phone clients used interoperate.
 *   pnpm attest:target-host
 * Interactive only. Writes experiments/telegram-calls/evidence/G0-F.local.json bound to the CURRENT build fingerprint. This is a human
 * statement, recorded as one; it counts only together with a clean two-way run record made with LIVE_TEST_HOST_IS_TARGET=yes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { computeBuildFingerprint } from '../modules/calls/capability-evidence.js';

if (!process.stdin.isTTY) {
  console.error('an interactive terminal is required');
  process.exit(2);
}
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const rl = createInterface({ input: process.stdin, output: process.stdout });
const host = (await rl.question('Target host / container (e.g. "Docker image tgvl-assistant on Ubuntu 24.04 VPS, Frankfurt"): ')).trim();
const clients = (await rl.question('Phone clients used for the live calls, comma separated (e.g. "Telegram iOS 11.x, Telegram Android 11.x"): '))
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);
const network = (await rl.question('Network configuration notes (ports/firewall/UDP), or "none": ')).trim();
const ok = (await rl.question('I ran the live gate calls with THIS build on THAT host and these clients. Type the full word yes: ')).trim().toLowerCase();
rl.close();
if (ok !== 'yes' || !host || !clients.length) {
  console.error('not recorded (a host, at least one client and a full "yes" are required)');
  process.exit(1);
}
const dir = join(root, 'experiments/telegram-calls/evidence');
mkdirSync(dir, { recursive: true });
const file = join(dir, 'G0-F.local.json');
writeFileSync(
  file,
  JSON.stringify(
    {
      kind: 'live',
      result: 'PASS',
      attestedBy: 'operator',
      recordedAt: new Date().toISOString(),
      buildFingerprint: computeBuildFingerprint(root),
      host,
      phoneClients: clients,
      network,
    },
    null,
    2,
  ),
);
console.log(`recorded ${file}`);
