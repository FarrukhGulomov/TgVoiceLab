import { describe, expect, it } from 'vitest';
import { chunkText, SAFE_CHUNK } from '../../apps/assistant/src/modules/messaging/chunk.js';
import { classifyTelegramSendError, PermanentDeliveryError } from '../../apps/assistant/src/modules/messaging/delivery-errors.js';

/** Audit F17: provider-safe outbound limits, centrally. */
describe('chunkText', () => {
  it('leaves short text untouched', () => {
    expect(chunkText('hello')).toEqual(['hello']);
    expect(chunkText('')).toEqual(['']);
  });
  it('splits on line boundaries, never exceeds the limit, and loses nothing', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `${i + 1}. ${'Vazifa sarlavhasi '.repeat(4)}${i}`);
    const text = lines.join('\n');
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(SAFE_CHUNK);
    expect(chunks.join('\n')).toBe(text); // numbered lines stay whole and in order
  });
  it('splits one huge line at spaces, and an unbroken run by code points without cutting a surrogate pair', () => {
    const words = 'so‘z '.repeat(3000);
    for (const c of chunkText(words)) expect(c.length).toBeLessThanOrEqual(SAFE_CHUNK);
    const emoji = '😀'.repeat(5000);
    const parts = chunkText(emoji);
    expect(parts.every((c) => c.length <= SAFE_CHUNK)).toBe(true);
    expect(parts.join('')).toBe(emoji);
    expect(parts.every((c) => !/[\uD800-\uDBFF]$/.test(c) && !/^[\uDC00-\uDFFF]/.test(c))).toBe(true);
  });
});

describe('classifyTelegramSendError', () => {
  it('treats deterministic provider rejections as permanent and connectivity as retryable', () => {
    for (const m of ['MESSAGE_TOO_LONG', 'USER_IS_BLOCKED', 'PEER_ID_INVALID', 'USER_DEACTIVATED', 'INPUT_USER_DEACTIVATED']) {
      const e = classifyTelegramSendError(Object.assign(new Error(m), { errorMessage: m }));
      expect(e).toBeInstanceOf(PermanentDeliveryError);
    }
    const net = new Error('ETIMEDOUT');
    expect(classifyTelegramSendError(net)).toBe(net);
    const flood = Object.assign(new Error('FLOOD_WAIT_5'), { errorMessage: 'FLOOD_WAIT_5' });
    expect(classifyTelegramSendError(flood)).toBe(flood);
  });
});
