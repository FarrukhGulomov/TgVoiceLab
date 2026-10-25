// Deployment fingerprint: sha256(pnpm-lock.yaml || each file under the FINGERPRINT_DIRS, sorted). The directories cover everything that decides what a call does or costs (audit F-14).
// MUST stay byte-identical with computeBuildFingerprint() in apps/assistant/src/modules/calls/capability-evidence.ts
// (tests/unit/build-fingerprint.test.ts enforces this).
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FINGERPRINT_DIRS = [
  // transport and media
  'apps/assistant/src/infrastructure/telegram',
  'apps/assistant/src/infrastructure/audio',
  // the AI / voice providers a call talks through
  'apps/assistant/src/infrastructure/openai',
  'apps/assistant/src/infrastructure/gemini',
  'apps/assistant/src/infrastructure/voicelab',
  // orchestration, adapter, audio bridge and the conversation runners (everything under modules/calls), the dial policy and live-call control
  'apps/assistant/src/modules/calls',
  'apps/assistant/src/modules/policy',
  'apps/assistant/src/modules/operations',
  'packages/contracts/src',
];

export function computeBuildFingerprint(repoRoot) {
  const h = createHash('sha256');
  h.update(readFileSync(join(repoRoot, 'pnpm-lock.yaml')));
  const walk = (d) =>
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(computeBuildFingerprint(resolve(fileURLToPath(new URL('..', import.meta.url)))));
}
