import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { aad, DecryptionError, Envelope, parseKeyRing } from '../../apps/assistant/src/infrastructure/crypto/envelope.js';

const ring = (active: string, ids: string[]) =>
  parseKeyRing(JSON.stringify({ active, keys: Object.fromEntries(ids.map((i) => [i, randomBytes(32).toString('base64')])) }));

describe('envelope encryption', () => {
  const env = new Envelope(ring('k1', ['k1']));
  it('round-trips and never contains plaintext', () => {
    const e = env.encrypt('Javlon credit workflow', aad('o1', 'tasks.title'));
    expect(e).not.toContain('Javlon');
    expect(env.decrypt(e, aad('o1', 'tasks.title'))).toBe('Javlon credit workflow');
  });
  it('uses a fresh nonce each time', () => {
    expect(env.encrypt('x', 'a')).not.toBe(env.encrypt('x', 'a'));
  });
  it('binds ciphertext to its owner/column context (AAD)', () => {
    const e = env.encrypt('secret', aad('owner-A', 'tasks.title'));
    expect(() => env.decrypt(e, aad('owner-B', 'tasks.title'))).toThrow(DecryptionError);
    expect(() => env.decrypt(e, aad('owner-A', 'memories.value'))).toThrow(DecryptionError);
  });
  it('detects tampering', () => {
    const parts = env.encrypt('secret', 'a').split('.');
    const body = Buffer.from(parts[3]!, 'base64url');
    body[0]! ^= 1;
    parts[3] = body.toString('base64url');
    expect(() => env.decrypt(parts.join('.'), 'a')).toThrow(DecryptionError);
  });
  it('supports rotation: old keys decrypt, new key encrypts, needsRotation flags old envelopes', () => {
    const k1 = randomBytes(32).toString('base64');
    const k2 = randomBytes(32).toString('base64');
    const oldEnv = new Envelope(parseKeyRing(JSON.stringify({ active: 'k1', keys: { k1 } })));
    const newEnv = new Envelope(parseKeyRing(JSON.stringify({ active: 'k2', keys: { k1, k2 } })));
    const e = oldEnv.encrypt('hello', 'a');
    expect(newEnv.needsRotation(e)).toBe(true);
    expect(newEnv.decrypt(e, 'a')).toBe('hello');
    const re = newEnv.encrypt(newEnv.decrypt(e, 'a'), 'a');
    expect(newEnv.needsRotation(re)).toBe(false);
    expect(() => oldEnv.decrypt(re, 'a')).toThrow(DecryptionError);
  });
  it('rejects malformed key rings', () => {
    expect(() => parseKeyRing(JSON.stringify({ active: 'k1', keys: { k1: Buffer.alloc(16).toString('base64') } }))).toThrow();
    expect(() => parseKeyRing(JSON.stringify({ active: 'zz', keys: { k1: randomBytes(32).toString('base64') } }))).toThrow();
  });
});
