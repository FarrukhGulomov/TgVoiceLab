// Deployment fingerprint: sha256(pnpm-lock.yaml || each file under apps/assistant/src/infrastructure/telegram, sorted).
// MUST stay byte-identical with computeBuildFingerprint() in apps/assistant/src/modules/calls/capability-evidence.ts
// (tests/unit/build-fingerprint.test.ts enforces this).
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function computeBuildFingerprint(repoRoot) {
  const h = createHash('sha256');
  h.update(readFileSync(join(repoRoot, 'pnpm-lock.yaml')));
  const dir = join(repoRoot, 'apps/assistant/src/infrastructure/telegram');
  const walk = (d) =>
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(computeBuildFingerprint(resolve(fileURLToPath(new URL('..', import.meta.url)))));
}
