/** Generates local development secrets into .local/secrets (mode 600). Prints only the .env lines, never the secret values. */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

const dir = resolve(process.cwd(), process.env.INIT_CWD ?? '.', '.local/secrets');
mkdirSync(dir, { recursive: true, mode: 0o700 });
const write = (name: string, content: string) => {
  const p = resolve(dir, name);
  if (existsSync(p)) return console.log(`kept existing ${p}`);
  writeFileSync(p, content, { mode: 0o600 });
  chmodSync(p, 0o600);
  console.log(`created ${p}`);
};
write('data-keys.json', JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } }));
write('admin-token', randomBytes(32).toString('base64url'));
console.log(`\nAdd to .env:\nDATA_ENCRYPTION_KEY_REF=file:${resolve(dir, 'data-keys.json')}\nADMIN_TOKEN_SECRET_REF=file:${resolve(dir, 'admin-token')}`);
