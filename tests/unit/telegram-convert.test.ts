import { describe, expect, it } from 'vitest';
import { convertMessage } from '../../apps/assistant/src/infrastructure/telegram/convert.js';

/** Audit F02: converting a Telegram message must never download media; the payload is fetched lazily, after authorization. */
const fakeVoice = (size: number) => ({
  mimeType: 'audio/ogg',
  size: { toString: () => String(size) },
  attributes: [{ duration: 12 }],
});
const fakeMsg = (over: Record<string, unknown> = {}) =>
  ({
    id: 7,
    senderId: { toString: () => '111' },
    chatId: { toString: () => '111' },
    date: 1_700_000_000,
    out: false,
    message: '',
    voice: fakeVoice(5000),
    ...over,
  }) as never;

describe('convertMessage (F02)', () => {
  it('does not call the downloader while converting a voice message', () => {
    let calls = 0;
    const m = convertMessage(fakeMsg(), 'acct', true, async () => {
      calls++;
      return Buffer.from('x');
    });
    expect(calls).toBe(0);
    expect(m?.voice).toMatchObject({ mime: 'audio/ogg', sizeBytes: 5000 });
    expect(typeof m?.voice?.download).toBe('function');
    expect(m?.voice?.bytes).toBeUndefined();
  });
  it('the lazy download calls the provider only when invoked', async () => {
    let calls = 0;
    const m = convertMessage(fakeMsg(), 'acct', true, async () => {
      calls++;
      return Buffer.from('abc');
    });
    const bytes = await m!.voice!.download!();
    expect(calls).toBe(1);
    expect(Buffer.from(bytes).toString()).toBe('abc');
  });
  it('plain text messages convert as before and never touch the downloader', () => {
    const m = convertMessage(fakeMsg({ voice: undefined, message: 'hello' }), 'acct', true, async () => {
      throw new Error('must not be called');
    });
    expect(m).toMatchObject({ text: 'hello', chat: { type: 'private', id: '111' }, senderTelegramId: '111' });
  });
});
