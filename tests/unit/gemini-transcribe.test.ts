import { describe, expect, it } from 'vitest';
import { GeminiTranscription } from '../../apps/assistant/src/infrastructure/gemini/transcribe.js';

const answer = (obj: unknown, ok = true, status = 200) =>
  (async (_u: unknown, init: { body: string }) => {
    answer.last = JSON.parse(init.body);
    return { ok, status, json: async () => ({ candidates: [{ content: { parts: [{ text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] } }] }) };
  }) as unknown as typeof fetch;
answer.last = undefined as unknown;
const mk = (f: typeof fetch) => new GeminiTranscription({ apiKey: 'k', model: 'm1', fetchImpl: f });
const audio = { bytes: new Uint8Array([1, 2, 3]), mime: 'audio/ogg; codecs=opus', durationSeconds: 3 };

describe('GeminiTranscription', () => {
  it('sends the audio inline and maps "confident" to a confidence above the intake threshold', async () => {
    const r = await mk(answer({ text: ' ertaga 10 da dori ichishni eslat ', confident: true, language: 'uz' })).transcribe(audio);
    expect(r).toEqual({ text: 'ertaga 10 da dori ichishni eslat', confidence: 0.9, language: 'uz' });
    const body = answer.last as { contents: Array<{ parts: Array<{ inline_data?: { mime_type: string; data: string } }> }> };
    expect(body.contents[0]!.parts[1]!.inline_data).toEqual({ mime_type: 'audio/ogg', data: 'AQID' });
  });
  it('"not confident" and empty speech both stay below the threshold so the owner is asked, not obeyed', async () => {
    expect((await mk(answer({ text: 'soat 5 da', confident: false })).transcribe(audio)).confidence).toBeLessThan(0.7);
    expect(await mk(answer({ text: '', confident: true })).transcribe(audio)).toEqual({ text: '', confidence: 0 });
  });
  it('HTTP errors and non-JSON answers throw (the owner is told the voice note failed)', async () => {
    await expect(mk(answer({}, false, 500)).transcribe(audio)).rejects.toThrow('HTTP 500');
    const bad = (async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: { status: 'INVALID_ARGUMENT', message: 'model does not support generateContent' } }),
    })) as unknown as typeof fetch;
    await expect(mk(bad).transcribe(audio)).rejects.toThrow('HTTP 400 (INVALID_ARGUMENT: model does not support generateContent)');
    // plain text (dedicated transcription models) and fenced JSON are both accepted; the request carries no JSON-mode flag
    expect(await mk(answer('ertaga soat 10 da dori ichishni eslat')).transcribe(audio)).toEqual({
      text: 'ertaga soat 10 da dori ichishni eslat',
      confidence: 0.75,
    });
    expect((await mk(answer('```json\n{"text":"salom","confident":true}\n```')).transcribe(audio)).text).toBe('salom');
    expect(JSON.stringify(answer.last)).not.toContain('responseMimeType');
  });
});
