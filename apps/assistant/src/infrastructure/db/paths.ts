import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo-root `db/migrations`, resolvable from both src (tsx) and dist builds. */
export const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../db/migrations');
