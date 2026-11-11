/** After restoring a backup: re-apply recorded deletions so deleted content does not resurface. Idempotent. */
import { loadConfig } from '../bootstrap/config.js';
import { Db } from '../infrastructure/db/db.js';
import { replayTombstones } from '../modules/retention/retention.js';

const db = new Db(loadConfig().DATABASE_URL);
try {
  console.log(JSON.stringify(await replayTombstones(db)));
} finally {
  await db.close();
}
