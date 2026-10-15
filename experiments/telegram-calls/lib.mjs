// Shared helpers for the Phase 0 spike scripts. No secret value is ever printed or logged from here.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const EVIDENCE_DIR = process.env.SPIKE_EVIDENCE_DIR
  ? resolve(process.env.SPIKE_EVIDENCE_DIR)
  : resolve(dirname(fileURLToPath(import.meta.url)), 'evidence');
export const sessionPath = () => resolve(process.env.TELEGRAM_SESSION_FILE ?? resolve(ROOT, '.local/secrets/telegram.session'));

/** Exit code 2 = "prerequisite missing" (distinct from 1 = test failed). Never a silent skip. */
export function blocked(lines) {
  console.error('\nBLOCKED_EXTERNAL — this live script did not run, and that is NOT a pass.\n');
  for (const l of lines) console.error(`  - ${l}`);
  console.error('\nSee docs/research/telegram-private-calls.md §9 for the exact setup.\n');
  process.exit(2);
}

export function requireTelegramCredentials() {
  const missing = [];
  if (!/^\d+$/.test(process.env.TELEGRAM_API_ID ?? '')) missing.push('TELEGRAM_API_ID (numeric, from my.telegram.org) is not set in .env');
  if ((process.env.TELEGRAM_API_HASH ?? '').length < 8) missing.push('TELEGRAM_API_HASH is not set in .env');
  return { missing, apiId: Number(process.env.TELEGRAM_API_ID), apiHash: process.env.TELEGRAM_API_HASH ?? '' };
}

/** Prompt on a TTY. `hidden` suppresses echo (OTP, 2FA password). Refuses to run non-interactively. */
export function ask(question, { hidden = false } = {}) {
  if (!process.stdin.isTTY)
    blocked(['interactive terminal required: credentials, OTPs and 2FA passwords are entered locally, never piped or pasted into a chat']);
  return new Promise((res) => {
    let muted = false;
    const out = new Writable({
      write(chunk, _e, cb) {
        if (!muted) process.stdout.write(chunk);
        cb();
      },
    });
    const rl = createInterface({ input: process.stdin, output: out, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      res(answer.trim());
    });
    muted = hidden;
  });
}

export function writeSecretFile(path, content) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}
export const readSecretFileIfPresent = (path) => (existsSync(path) ? readFileSync(path, 'utf8').trim() : '');

export function writeEvidence(name, obj) {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const p = resolve(EVIDENCE_DIR, name);
  writeFileSync(p, JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n');
  return p;
}
export const readEvidence = (name) => {
  const p = resolve(EVIDENCE_DIR, name);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
};
export const pins = () => ({
  ntgcalls: JSON.parse(readFileSync(resolve(ROOT, 'experiments/telegram-calls/node_modules/ntgcalls/package.json'), 'utf8')).version,
  telegram: JSON.parse(readFileSync(resolve(ROOT, 'experiments/telegram-calls/node_modules/telegram/package.json'), 'utf8')).version,
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
});
