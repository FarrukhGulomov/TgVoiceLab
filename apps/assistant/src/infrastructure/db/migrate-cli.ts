import { Db } from './db.js';
import { migrate } from './migrate.js';
import { MIGRATIONS_DIR } from './paths.js';

// Migrations run as the schema-owning login (tgvl_migrator), which is NOT the runtime login. Only DATABASE_URL is read here, so the
// migrate step needs no application secrets at all.
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL (the MIGRATION role connection) is required');
  process.exit(2);
}
const db = new Db(url);
try {
  const r = await migrate(db, MIGRATIONS_DIR);
  console.log(JSON.stringify(r));
} finally {
  await db.close();
}
