/**
 * Protected local owner bootstrap. Prints BOTH numeric ids and requires the operator to retype a confirmation that echoes them.
 * Never enrolls "the first sender". Secrets are references only; nothing secret is asked for or printed.
 */
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../bootstrap/config.js';
import { Db } from '../infrastructure/db/db.js';
import { bootstrapOwner, bootstrapPhrase } from '../modules/identity/identity.js';

const cfg = loadConfig();
const rl = createInterface({ input: process.stdin, output: process.stdout });
const owner = (process.env.BOOTSTRAP_OWNER_ID ?? (await rl.question('Owner numeric Telegram user id (the human): '))).trim();
const asst = (process.env.BOOTSTRAP_ASSISTANT_ID ?? (await rl.question('Assistant account numeric Telegram user id: '))).trim();
const ref = (process.env.TELEGRAM_SESSION_SECRET_REF ?? (await rl.question('Session secret reference (file:/path or env:NAME): '))).trim();
console.log(`\nOwner (human):      ${owner}\nAssistant account:  ${asst}\nTimezone:           ${cfg.OWNER_TIMEZONE}\n`);
console.log(`Type exactly to confirm:\n  ${bootstrapPhrase(owner, asst)}`);
const confirmation = await rl.question('> ');
rl.close();
const db = new Db(cfg.DATABASE_URL);
try {
  const r = await bootstrapOwner(db, { ownerTelegramId: owner, assistantTelegramId: asst, sessionSecretRef: ref, timezone: cfg.OWNER_TIMEZONE, confirmation });
  console.log(
    r.created ? 'Owner bootstrapped. Calling remains DISABLED (kill switch on, no evidence).' : 'Already bootstrapped with these ids; nothing changed.',
  );
} finally {
  await db.close();
}
