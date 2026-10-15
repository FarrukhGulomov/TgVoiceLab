/** Re-encrypt all data under the ACTIVE key of DATA_ENCRYPTION_KEY_REF (keep retired keys in the ring until remainingOnOldKeys is 0). */
import { loadConfig } from '../bootstrap/config.js';
import { Db } from '../infrastructure/db/db.js';
import { Envelope, parseKeyRing } from '../infrastructure/crypto/envelope.js';
import { resolveSecret } from '../infrastructure/crypto/secrets.js';
import { rotateKeys } from '../modules/retention/rotate-keys.js';

const cfg = loadConfig();
if (!cfg.DATA_ENCRYPTION_KEY_REF) throw new Error('DATA_ENCRYPTION_KEY_REF is required');
const db = new Db(cfg.DATABASE_URL);
try {
  console.log(JSON.stringify(await rotateKeys(db, new Envelope(parseKeyRing(resolveSecret(cfg.DATA_ENCRYPTION_KEY_REF)))))); // counts only
} finally {
  await db.close();
}
