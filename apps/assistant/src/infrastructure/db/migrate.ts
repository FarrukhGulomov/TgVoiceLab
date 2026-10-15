import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './db.js';

const FILE_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;
const LOCK_KEY = 727_274_001;

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Forward-only SQL migrations. Applied files are checksum-verified: editing a shipped migration is an error.
 * This runner NEVER drops or resets anything (spec: never auto-reset a nonempty database).
 */
export async function migrate(db: Db, dir: string): Promise<MigrationResult> {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) if (!FILE_RE.test(f)) throw new Error(`bad migration filename: ${f}`);
  const client = await db.pool.connect();
  const result: MigrationResult = { applied: [], alreadyApplied: [] };
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map<string, string>(
      (await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations')).rows.map((r) => [r.version, r.checksum]),
    );
    for (const f of files) {
      const sql = readFileSync(join(dir, f), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prior = done.get(f);
      if (prior) {
        if (prior !== checksum) throw new Error(`migration ${f} was modified after being applied`);
        result.alreadyApplied.push(f);
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [f, checksum]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${f} failed: ${(e as Error).message}`);
      }
      result.applied.push(f);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
  return result;
}
