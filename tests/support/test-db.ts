import { randomBytes } from 'node:crypto';
import { Db } from '../../apps/assistant/src/infrastructure/db/db.js';
import { adminClient, TEMPLATE_DB, urlFor } from './pg.js';

export interface TestDb {
  db: Db;
  name: string;
  url: string;
  drop(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const name = `tgvl_t_${randomBytes(6).toString('hex')}`;
  const admin = await adminClient();
  try {
    await admin.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`);
  } finally {
    await admin.end();
  }
  const url = urlFor(name);
  const db = new Db(url, undefined, 8);
  return {
    db,
    name,
    url,
    async drop() {
      await db.close();
      const a = await adminClient();
      try {
        await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await a.end();
      }
    },
  };
}
