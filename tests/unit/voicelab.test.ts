import { describe, expect, it } from 'vitest';
import { VoiceLabTts, parseWav } from '../../apps/assistant/src/infrastructure/voicelab/tts.js';
import { VoiceLabMouthLink, languageOf, speakable, takeSentences, type TextBrain } from '../../apps/assistant/src/infrastructure/voicelab/mouth-link.js';
import { sessionUpdate } from '../../apps/assistant/src/infrastructure/openai/realtime.js';
import type { ToolCall } from '../../apps/assistant/src/modules/calls/audio/realtime-bridge.js';

function wav(samples: number, rate = 24000, extraChunk = false): Uint8Array {
  const data = Buffer.alloc(samples * 2, 1);
  const parts: Buffer[] = [];
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0);
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(rate, 12);
  fmt.writeUInt32LE(rate * 2, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);
  parts.push(fmt);
  if (extraChunk) {
    const l = Buffer.alloc(8 + 4);
    l.write('LIST', 0);
    l.writeUInt32LE(4, 4);
    parts.push(l);
  }
  const d = Buffer.alloc(8);
  d.write('data', 0);
  d.writeUInt32LE(data.length, 4);
  parts.push(d, data);
  const body = Buffer.concat(parts);
  const h = Buffer.alloc(12);
  h.write('RIFF', 0);
  h.writeUInt32LE(4 + body.length, 4);
  h.write('WAVE', 8);
  return new Uint8Array(Buffer.concat([h, body]));
}

describe('WAV parsing', () => {
  it('reads rate and samples, skipping other chunks', () => {
    const a = parseWav(wav(480, 24000, true));
    expect(a.rateHz).toBe(24000);
    expect(a.pcm.length).toBe(960);
  });
  it('refuses a non-WAV or a stereo file', () => {
    expect(() => parseWav(new Uint8Array(20))).toThrow();
  });
});

describe('VoiceLabTts', () => {
  it('posts text, language and voice with a bearer key; model only when configured', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(wav(240), { status: 200 });
    }) as unknown as typeof fetch;
    const t = new VoiceLabTts({ apiKey: 'vlk_x', voiceId: 'v1', fetchImpl });
    const a = await t.synthesize('Salom', 'uz');
    expect(a.pcm.length).toBe(480);
    expect(seen[0]!.url).toBe('https://api.voicelab.uz/v1/tts');
    expect((seen[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer vlk_x');
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ text: 'Salom', language: 'uz', voice_id: 'v1' });
    await new VoiceLabTts({ apiKey: 'k', voiceId: 'v1', model: 'lison-v1', fetchImpl }).synthesize('Salom', 'uz');
    expect(JSON.parse(String(seen[1]!.init.body)).model_id).toBe('lison-v1');
  });
  it('a provider error is readable and carries no key', async () => {
    const fetchImpl = (async () => new Response('{"error":{"code":"invalid_api_key"}}', { status: 401 })) as unknown as typeof fetch;
    await expect(new VoiceLabTts({ apiKey: 'secret', voiceId: 'v', fetchImpl }).synthesize('Salom', 'uz')).rejects.toThrow(/401.*invalid_api_key/);
  });
});

describe('text -> speech helpers', () => {
  it('cuts sentences, keeps the unfinished rest and decimals', () => {
    expect(takeSentences('Salom Farruh. Narx 12.5 ming. Yana')).toEqual({ sentences: ['Salom Farruh. ', 'Narx 12.5 ming. '], rest: 'Yana' });
    expect(takeSentences('Tayyor.')).toEqual({ sentences: [], rest: 'Tayyor.' }); // may still grow: waits for the next delta or the end
  });
  it('drops markdown and emoji, picks the language', () => {
    expect(speakable('**Salom** 😊 _Farruh_!')).toBe('Salom Farruh !');
    expect(languageOf('Привет, как дела?')).toBe('ru');
    expect(languageOf('Hello, thank you very much')).toBe('en');
    expect(languageOf('Assalomu alaykum, men Farruhning yordamchisiman')).toBe('uz');
  });
  it('text mode asks the model for text only, with no audio output', () => {
    const u = sessionUpdate({ instructions: 'x', textOutput: true }) as { session: { output_modalities: string[]; audio: Record<string, unknown> } };
    expect(u.session.output_modalities).toEqual(['text']);
    expect(u.session.audio.output).toBeUndefined();
  });
});

class FakeBrain implements TextBrain {
  inputRateHz = 24000;
  outputRateHz = 24000;
  textCb!: (d: string, done: boolean) => void;
  toolCb!: (c: ToolCall) => void;
  speechCb!: () => void;
  interrupts: number[] = [];
  onText(cb: (d: string, done: boolean) => void) {
    this.textCb = cb;
  }
  onToolCall(cb: (c: ToolCall) => void) {
    this.toolCb = cb;
  }
  onSpeechStarted(cb: () => void) {
    this.speechCb = cb;
  }
  sendAudio() {}
  respond() {}
  interrupt(ms: number) {
    this.interrupts.push(ms);
  }
  onResponseStart() {}
  audioCb: (p: Uint8Array) => void = () => undefined;
  onAudio(cb: (p: Uint8Array) => void) {
    this.audioCb = cb;
  }
  onTranscript() {}
  onError() {}
  sendToolResult() {}
  close() {}
}

const waitFor = async (ok: () => boolean, ms = 3000) => {
  for (const start = Date.now(); !ok() && Date.now() - start < ms;) await new Promise((r) => setTimeout(r, 10));
};

describe('VoiceLabMouthLink', () => {
  const mk = (delays: Record<string, number> = {}, idleFlushMs?: { sentence: number; other: number }) => {
    const brain = new FakeBrain();
    const spoken: string[] = [];
    const tts = {
      synthesize: async (text: string) => {
        await new Promise((r) => setTimeout(r, delays[text] ?? 1));
        spoken.push(text);
        return { pcm: new Uint8Array(9600), rateHz: 24000 };
      },
    };
    const link = new VoiceLabMouthLink(brain, tts, { idleFlushMs });
    const chunks: number[] = [];
    link.onAudio((p) => chunks.push(p.length));
    return { brain, link, spoken, chunks };
  };

  it('voices sentences in order even when a later one is synthesised faster', async () => {
    const { brain, chunks } = mk({ 'Birinchi gap.': 40 });
    brain.textCb('Birinchi gap. Ikkinchi gap. ', false);
    brain.textCb('Uchinchi', false);
    brain.textCb(' gap.', true);
    await waitFor(() => chunks.length >= 6);
    await new Promise((r) => setTimeout(r, 50));
    expect(chunks.length).toBe(6); // 3 sentences x 2 pieces of ~100 ms (9600 bytes = 200 ms)
  });

  it('a tool call waits until what was said before it has been voiced (no hang-up mid-farewell)', async () => {
    const { brain, link, chunks } = mk({ 'Xayr.': 30 });
    let audioAtTool = -1;
    link.onToolCall(() => (audioAtTool = chunks.length));
    brain.textCb('Xayr.', true);
    brain.toolCb({ id: '1', name: 'end_call', args: {} });
    await waitFor(() => audioAtTool >= 0);
    expect(audioAtTool).toBe(2);
  });

  it('the last sentence is voiced when the text goes quiet, without waiting for the turn-complete signal', async () => {
    const { brain, chunks, spoken } = mk({}, { sentence: 20, other: 60 });
    brain.textCb('Assalomu alaykum, men yordamchiman.', false); // no space after the full stop, no "done" yet
    await waitFor(() => chunks.length >= 2);
    expect(spoken).toEqual(['Assalomu alaykum, men yordamchiman.']);
    brain.textCb('Sizga qanday', false); // unfinished and quiet: still voiced after the longer pause
    await waitFor(() => spoken.length === 2);
    expect(spoken[1]).toBe('Sizga qanday');
  });

  it('the caller speaking before anything was audible stops nothing; speaking over audible audio does', async () => {
    const { brain, link, chunks } = mk();
    let barge = 0;
    link.onSpeechStarted(() => barge++);
    brain.textCb('Birinchi gap.', true);
    brain.speechCb(); // the model heard the caller before Nozima said a word
    await waitFor(() => chunks.length >= 2);
    expect(barge).toBe(0);
    expect(chunks.length).toBe(2); // the answer is still spoken
    brain.speechCb(); // now the caller talks over the audio that is playing
    expect(barge).toBe(1);
  });

  it('barge-in drops what has not been played yet and tells the model', async () => {
    const { brain, link, chunks } = mk({ 'Uzun gap.': 50 });
    brain.textCb('Uzun gap.', true);
    link.interrupt(300);
    await new Promise((r) => setTimeout(r, 150));
    expect(chunks).toHaveLength(0);
    expect(brain.interrupts).toEqual([300]);
  });
});

import { geminiSetup } from '../../apps/assistant/src/infrastructure/gemini/live.js';
describe('VoiceLab out of service', () => {
  it("after repeated synthesis failures the brain's own voice takes over; before that its audio is dropped", async () => {
    const brain = new FakeBrain();
    const errors: string[] = [];
    const tts = {
      synthesize: async () => {
        throw new Error('HTTP 402 insufficient_credits');
      },
    };
    const link = new VoiceLabMouthLink(brain, tts);
    const got: number[] = [];
    link.onAudio((p) => got.push(p.length));
    link.onError((m) => errors.push(m));
    brain.audioCb(new Uint8Array(100));
    expect(got).toEqual([]); // VoiceLab still in charge: the model's own audio is not played
    brain.textCb('Birinchi. ', false);
    brain.textCb('Ikkinchi. ', false);
    await waitFor(() => errors.length >= 2);
    await new Promise((r) => setTimeout(r, 20));
    brain.audioCb(new Uint8Array(100));
    expect(got).toEqual([100]);
  });
});

describe('Gemini Live in text mode', () => {
  it('asks for TEXT only (no audio output settings) so VoiceLab can speak it', () => {
    const s = (geminiSetup({ model: 'm', instructions: 'x', textOutput: true, voice: 'v', languageCode: 'uz-UZ' }) as { setup: Record<string, any> }).setup;
    expect(s.generationConfig.responseModalities).toEqual(['TEXT']);
    expect(s.generationConfig.speechConfig).toBeUndefined();
    expect(s.outputAudioTranscription).toBeUndefined();
    const a = (geminiSetup({ model: 'm', instructions: 'x' }) as { setup: Record<string, any> }).setup;
    expect(a.generationConfig.responseModalities).toEqual(['AUDIO']);
  });
});

import { loadConfig } from '../../apps/assistant/src/bootstrap/config.js';
describe('VoiceLab configuration', () => {
  const base = { DATABASE_URL: 'postgres://x', TTS_PROVIDER: 'voicelab', VOICELAB_API_KEY: 'k', VOICELAB_VOICE_ID: 'v' };
  it('works on top of gemini or openai, needs a listening model and the key and voice', () => {
    expect(() => loadConfig({ ...base, AI_VOICE_PROVIDER: 'gemini' })).not.toThrow();
    expect(() => loadConfig({ ...base, AI_VOICE_PROVIDER: 'openai' })).not.toThrow();
    expect(() => loadConfig({ ...base })).toThrow(/AI_VOICE_PROVIDER/);
    expect(() => loadConfig({ ...base, AI_VOICE_PROVIDER: 'gemini', VOICELAB_VOICE_ID: '' })).toThrow(/VOICELAB_VOICE_ID/);
  });
});

import { EventEmitter } from 'node:events';
import { GeminiLiveLink } from '../../apps/assistant/src/infrastructure/gemini/live.js';
describe('Gemini Live: transcript mode', () => {
  it('asks for audio plus an output transcription, drops the model audio and streams the transcript as text', () => {
    const t = (geminiSetup({ model: 'm', instructions: 'x', textOutput: 'transcript' }) as { setup: Record<string, any> }).setup;
    expect(t.generationConfig.responseModalities).toEqual(['AUDIO']);
    expect(t.outputAudioTranscription).toEqual({});

    const ws = Object.assign(new EventEmitter(), { send: () => undefined, close: () => undefined });
    const link = new GeminiLiveLink({ apiKey: 'k', model: 'm', instructions: 'x', textOutput: 'transcript', socketFactory: () => ws as never });
    const text: Array<[string, boolean]> = [];
    let audio = 0;
    link.onText((d, done) => text.push([d, done]));
    link.onAudio(() => audio++);
    const msg = (o: unknown) => ws.emit('message', Buffer.from(JSON.stringify(o)));
    msg({ setupComplete: {} });
    msg({
      serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAA' } }] }, outputTranscription: { text: 'Salom. ' } },
    });
    msg({ serverContent: { outputTranscription: { text: 'Qalaysiz?' } } });
    msg({ serverContent: { turnComplete: true } });
    expect(audio).toBe(0);
    expect(text).toEqual([
      ['Salom. ', false],
      ['Qalaysiz?', false],
      ['', true],
    ]);
  });
});

describe('Gemini turn-taking tuning', () => {
  it('is sent only when configured', () => {
    const none = (geminiSetup({ model: 'm', instructions: 'x' }) as { setup: Record<string, any> }).setup;
    expect(none.realtimeInputConfig).toBeUndefined();
    const t = (geminiSetup({ model: 'm', instructions: 'x', vad: { silenceMs: 900, end: 'low' } }) as { setup: Record<string, any> }).setup;
    expect(t.realtimeInputConfig.automaticActivityDetection).toEqual({ endOfSpeechSensitivity: 'END_SENSITIVITY_LOW', silenceDurationMs: 900 });
  });
});

describe('VoiceReplies', () => {
  it('synthesises, encodes and sends short replies; long ones and symbols-only are skipped; failures are swallowed', async () => {
    const { VoiceReplies } = await import('../../apps/assistant/src/infrastructure/voicelab/voice-reply.js');
    const sent: Array<{ to: string; bytes: number; dur: number }> = [];
    const tts = { synthesize: async () => ({ pcm: new Uint8Array(48000), rateHz: 24000 }) };
    const v = new VoiceReplies(
      tts,
      async (to, ogg, dur) => void sent.push({ to, bytes: ogg.length, dur }),
      async () => Buffer.from('ogg'),
    );
    await v.speak('1', 'Salom, **vazifa** qo‘shildi.', 'k');
    await v.speak('1', '😀', 'k');
    await v.speak('1', 'a '.repeat(400), 'k');
    expect(sent).toEqual([{ to: '1', bytes: 3, dur: 1 }]);
    const bad = new VoiceReplies(
      tts,
      async () => {
        throw new Error('x');
      },
      async () => Buffer.from('ogg'),
    );
    await expect(bad.speak('1', 'Salom.', 'k')).resolves.toBeUndefined();
  });
});

describe('VoiceLabMouthLink: first words sooner', () => {
  it('the first chunk of an answer is cut at a comma instead of waiting for the full stop; later chunks follow normal sentences', async () => {
    const brain = new FakeBrain();
    const spoken: string[] = [];
    const tts = {
      synthesize: async (t: string) => {
        spoken.push(t);
        return { pcm: new Uint8Array(9600), rateHz: 24000 };
      },
    };
    const link = new VoiceLabMouthLink(brain, tts, { idleFlushMs: { sentence: 5000, other: 5000 } });
    link.onAudio(() => undefined);
    brain.textCb('Xo‘p, tushundim, hozir egangizga aytib qo‘yaman, keyin javob olib kelaman', false);
    await waitFor(() => spoken.length >= 1);
    expect(spoken[0]).toBe('Xo‘p, tushundim, hozir egangizga aytib qo‘yaman,');
    brain.textCb(' xo‘pmi? ', false);
    await waitFor(() => spoken.length >= 2);
    expect(spoken[1]).toBe('keyin javob olib kelaman xo‘pmi?');
  });
});

describe('takeSentences: long runs', () => {
  it('cuts a long unpunctuated run at a late comma, and only falls back to a space past 220 characters', () => {
    const long = 'Mashinaning holati juda yaxshi, hech qanday muammosi yo‘q, hujjatlari ham tayyor, faqat narxini kelishib olishimiz kerak xolos';
    const r = takeSentences(long);
    expect(r.sentences).toHaveLength(1);
    expect(r.sentences[0]!.endsWith(',')).toBe(true);
    expect(r.sentences[0]!.length).toBeLessThanOrEqual(86);
    expect(takeSentences('qisqa gap, davomi')).toEqual({ sentences: [], rest: 'qisqa gap, davomi' });
  });
});
