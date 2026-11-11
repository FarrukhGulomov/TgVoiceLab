import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { computeBuildFingerprint as ts } from '../../apps/assistant/src/modules/calls/capability-evidence.js';
// @ts-expect-error plain .mjs helper without types
import { computeBuildFingerprint as mjs } from '../../scripts/build-fingerprint.mjs';

describe('build fingerprint', () => {
  it('the script used in Docker/CI and the runtime implementation agree byte for byte', () => {
    const root = resolve(__dirname, '../..');
    expect(mjs(root)).toBe(ts(root));
    expect(ts(root)).toMatch(/^[a-f0-9]{64}$/);
  });
});
