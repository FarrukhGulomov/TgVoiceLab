import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locate `db/migrations` by walking up from this module (works from `src` under tsx, from `dist`, and inside the container
 * where `db/` sits next to `dist/`). `MIGRATIONS_DIR` overrides for unusual layouts.
 */
function findMigrationsDir(): string {
  if (process.env.MIGRATIONS_DIR) return resolve(process.env.MIGRATIONS_DIR);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'db', 'migrations');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error('could not locate db/migrations (set MIGRATIONS_DIR)');
}
export const MIGRATIONS_DIR = findMigrationsDir();
