// G0-A: protected interactive login + identity verification for the DEDICATED assistant account.
// The phone number, login code and 2FA password are typed locally (hidden). The session is written to a mode-600 file and never printed.
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { ask, blocked, pins, readSecretFileIfPresent, requireTelegramCredentials, sessionPath, writeEvidence, writeSecretFile } from './lib.mjs';

const { missing, apiId, apiHash } = requireTelegramCredentials();
// Check BEFORE any network activity: credentials, OTPs and 2FA passwords are typed locally on a terminal, never piped.
if (!process.stdin.isTTY) missing.push('interactive terminal required: the login code and 2FA password are entered locally, never piped or pasted into a chat');
if (missing.length) blocked(missing);

const path = sessionPath();
const client = new TelegramClient(new StringSession(readSecretFileIfPresent(path)), apiId, apiHash, { connectionRetries: 3 });
await client.start({
  phoneNumber: () => ask('Assistant account phone number (international format): '),
  phoneCode: () => ask('Login code sent by Telegram: ', { hidden: true }),
  password: () => ask('2FA password (leave empty if none): ', { hidden: true }),
  onError: (e) => console.error(`login error: ${e.message}`),
});
const me = await client.getMe();
writeSecretFile(path, client.session.save());
console.log(`\nLogged in. Assistant numeric id: ${me.id.toString()}`);
console.log('Compare this id with the assistant id you pass to `pnpm bootstrap:owner`. It must NOT be your own personal account.');
console.log(`Session saved to ${path} (mode 600; not printed).`);
const ev = writeEvidence('G0-A.local.json', {
  gate: 'G0-A',
  kind: 'live',
  recordedAt: new Date().toISOString(),
  pins: pins(),
  result: 'PASS',
  detail: 'headless-capable MTProto login completed; identity read back via users.getUsers(self)',
  assistantUserIdSha256Prefix: (await import('node:crypto')).createHash('sha256').update(me.id.toString()).digest('hex').slice(0, 12),
});
console.log(`Evidence record: ${ev}`);
await client.disconnect();
process.exit(0);
