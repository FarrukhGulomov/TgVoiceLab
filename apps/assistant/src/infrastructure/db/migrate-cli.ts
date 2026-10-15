import { loadConfig } from '../../bootstrap/config.js';
import { Db } from './db.js';
import { migrate } from './migrate.js';
import { MIGRATIONS_DIR } from './paths.js';

const cfg = loadConfig();
const db = new Db(cfg.DATABASE_URL);
try {
  const r = await migrate(db, MIGRATIONS_DIR);
  console.log(JSON.stringify(r));
} finally {
  await db.close();
}
