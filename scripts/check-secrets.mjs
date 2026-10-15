// Lightweight secret scan over tracked files. Fails the build on likely committed secrets. Add `pragma: allowlist-secret`
// on a line that intentionally contains a fake token (test fixtures). This complements, not replaces, a managed scanner.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PATTERNS = [
  ['Telegram bot token', /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/],
  ['OpenAI-style API key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['Private key block', /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/],
  ['Telegram api_hash literal', /api_?hash["'\s:=]+[0-9a-f]{32}\b/i],
  ['Telethon/GramJS-style session string', /\b1[A-Za-z0-9+/_-]{250,}={0,2}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Bearer token literal', /Bearer\s+[A-Za-z0-9._~+/-]{40,}/],
];
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  .filter((f) => !/(pnpm-lock\.yaml|\.png|\.jpg|\.wav|\.node)$/.test(f));
const hits = [];
for (const f of files) {
  let text;
  try {
    text = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  text.split('\n').forEach((line, i) => {
    if (line.includes('pragma: allowlist-secret')) return;
    for (const [name, re] of PATTERNS) if (re.test(line)) hits.push(`${f}:${i + 1}: ${name}`);
  });
}
if (hits.length) {
  console.error('Possible secrets committed:\n' + hits.map((h) => '  ' + h).join('\n'));
  process.exit(1);
}
console.log(`secret scan: ${files.length} tracked files clean`);
