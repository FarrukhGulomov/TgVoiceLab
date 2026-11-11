import { loadConfig } from '../../bootstrap/config.js';
import { Db } from './db.js';

const cfg = loadConfig();
if (cfg.NODE_ENV === 'production') {
  console.error('refusing to seed a production database');
  process.exit(1);
}
const db = new Db(cfg.DATABASE_URL);
try {
  const r = await db.query<{ id: string }>('SELECT id FROM owners LIMIT 1');
  console.log(
    r.rows[0] ? 'Owner exists; nothing to seed (tasks/reminders are created through the assistant).' : 'No owner yet. Run `pnpm bootstrap:owner` first.',
  );
} finally {
  await db.close();
}
