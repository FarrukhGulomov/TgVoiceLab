import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveCapabilities } from '../../apps/assistant/src/modules/calls/capability-evidence.js';

/**
 * Spec: live scripts must "fail clearly when prerequisites are absent, rather than silently skipping and appearing successful".
 * These run the real scripts offline; none of them can reach Telegram because every one is refused before connecting.
 */
const DIR = resolve(__dirname, '../../experiments/telegram-calls');
const run = (script: string, env: Record<string, string> = {}, args: string[] = []) => {
  const tmp = mkdtempSync(join(tmpdir(), 'spike-'));
  const r = spawnSync(process.execPath, [join(DIR, script), ...args], {
    cwd: DIR,
    env: { PATH: process.env.PATH ?? '', SPIKE_EVIDENCE_DIR: tmp, TELEGRAM_SESSION_FILE: join(tmp, 'none.session'), ...env },
    encoding: 'utf8',
    timeout: 20_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.error) throw r.error; // a hung script is a test failure, not a hang
  return { ...r, tmp, out: `${r.stdout}${r.stderr}` };
};
const creds = { TELEGRAM_API_ID: '12345', TELEGRAM_API_HASH: 'abcdef0123456789' };
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const authorized = {
  ...creds,
  LIVE_TEST_OPT_IN: 'yes',
  LIVE_TEST_RECIPIENT_ID: '555000111',
  LIVE_TEST_RECIPIENT_CONSENT: 'yes',
  LIVE_TEST_WINDOW_START: iso(-60_000),
  LIVE_TEST_WINDOW_END: iso(3_600_000),
};

describe('live-call.mjs refuses without full authorization (exit 2, never a silent pass)', () => {
  it('nothing configured', () => {
    const r = run('live-call.mjs');
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/BLOCKED_EXTERNAL/);
    expect(r.out).toMatch(/NOT a pass/);
    for (const need of [
      'TELEGRAM_API_ID',
      'LIVE_TEST_OPT_IN',
      'LIVE_TEST_RECIPIENT_ID',
      'LIVE_TEST_RECIPIENT_CONSENT',
      'LIVE_TEST_WINDOW_START',
      'telegram.session|none.session',
    ])
      expect(r.out).toMatch(new RegExp(need));
  });
  it('credentials alone are not test authorization', () => {
    const r = run('live-call.mjs', creds);
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/LIVE_TEST_OPT_IN/);
  });
  it('rejects a non-numeric recipient (usernames are not identity) and missing participant consent', () => {
    const r = run('live-call.mjs', { ...authorized, LIVE_TEST_RECIPIENT_ID: '@javlon', LIVE_TEST_RECIPIENT_CONSENT: 'no' });
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/numeric Telegram id/);
    expect(r.out).toMatch(/LIVE_TEST_RECIPIENT_CONSENT/);
  });
  it('rejects a call outside the authorized window, and an over-long window', () => {
    const past = run('live-call.mjs', { ...authorized, LIVE_TEST_WINDOW_START: iso(-7200_000), LIVE_TEST_WINDOW_END: iso(-3600_000) });
    expect(past.out).toMatch(/outside the authorized test window/);
    const long = run('live-call.mjs', { ...authorized, LIVE_TEST_WINDOW_END: iso(5 * 3600_000) });
    expect(long.out).toMatch(/at most 2 hours/);
  });
  it('rejects out-of-range duration / repeat / scenario', () => {
    expect(run('live-call.mjs', { ...authorized, LIVE_TEST_MAX_SECONDS: '5' }).out).toMatch(/LIVE_TEST_MAX_SECONDS/);
    expect(run('live-call.mjs', { ...authorized, LIVE_TEST_REPEAT: '50' }).out).toMatch(/LIVE_TEST_REPEAT/);
    expect(run('live-call.mjs', { ...authorized, LIVE_TEST_SCENARIO: 'mass_dial' }).out).toMatch(/LIVE_TEST_SCENARIO/);
  });
  it('a fully authorized request still stops without a session (G0-A comes first)', () => {
    const r = run('live-call.mjs', authorized);
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/pnpm spike:login/);
  });
});

describe('login.mjs and record-gate.mjs', () => {
  it('login refuses without API credentials and without an interactive terminal', () => {
    expect(run('login.mjs').status).toBe(2);
    const r = run('login.mjs', creds);
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/interactive terminal required/);
  });
  it('record-gate refuses a PASS without an evidence file and without operator attestation', () => {
    const noFile = run('record-gate.mjs', {}, ['G0-F', 'PASS', 'does/not/exist.json']);
    expect(noFile.status).toBe(2);
    expect(noFile.out).toMatch(/evidence file/);
    const noAttest = run('record-gate.mjs', {}, ['G0-F', 'PASS', 'package.json']);
    expect(noAttest.status).toBe(2);
    expect(noAttest.out).toMatch(/OPERATOR_ATTESTS_LIVE=yes/);
    expect(run('record-gate.mjs', {}, ['G0-Z', 'PASS', 'package.json']).status).toBe(2);
  });
  it('record-gate accepts BLOCKED_EXTERNAL honestly (no attestation needed to say "not done")', () => {
    expect(run('record-gate.mjs', {}, ['G0-F', 'BLOCKED_EXTERNAL', 'package.json']).status).toBe(0);
  });
});

describe('evidence assembly can never enable production by itself', () => {
  it('with no live records every gate is BLOCKED_EXTERNAL and the app derives zero capability', () => {
    const r = run('build-evidence.mjs');
    expect(r.status).toBe(0);
    const art = JSON.parse(readFileSync(join(r.tmp, 'feasibility-evidence.local.json'), 'utf8'));
    expect(Object.values(art.gates).every((g: any) => g.result === 'BLOCKED_EXTERNAL')).toBe(true);
    expect(art.producedBy).toBe('spike');
    const caps = deriveCapabilities(join(r.tmp, 'feasibility-evidence.local.json'), art.buildFingerprint);
    expect(caps).toMatchObject({ privateOutbound: false, pcmSend: false, pcmReceive: false, productionCallingAllowed: false });
  });
  it('even a hand-edited all-PASS spike artifact is rejected by the application (producedBy must be production-adapter)', () => {
    const r = run('build-evidence.mjs');
    const p = join(r.tmp, 'feasibility-evidence.local.json');
    const art = JSON.parse(readFileSync(p, 'utf8'));
    for (const g of Object.keys(art.gates)) art.gates[g] = { result: 'PASS', kind: 'live', recordedAt: '2026-10-20T10:00:00Z', evidenceRefs: ['x'] };
    writeFileSync(p, JSON.stringify(art));
    expect(deriveCapabilities(p, art.buildFingerprint).productionCallingAllowed).toBe(false);
  });
});
