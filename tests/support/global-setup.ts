import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Db } from '../../apps/assistant/src/infrastructure/db/db.js';
import { migrate } from '../../apps/assistant/src/infrastructure/db/migrate.js';
import { adminClient, TEMPLATE_DB, urlFor } from './pg.js';

const MIGRATIONS = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../db/migrations');

/** Build a migrated template database once; each test file clones it for full isolation. */
export default async function setup() {
  const admin = await adminClient();
  try {
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [TEMPLATE_DB]);
    await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB}`);
    await admin.query(`CREATE DATABASE ${TEMPLATE_DB}`);
  } finally {
    await admin.end();
  }
  const db = new Db(urlFor(TEMPLATE_DB), undefined, 2);
  try {
    await migrate(db, MIGRATIONS);
  } finally {
    await db.close();
  }
}
