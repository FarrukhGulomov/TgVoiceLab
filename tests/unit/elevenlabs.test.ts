import { describe, expect, it } from 'vitest';
import { ElevenLabsTts } from '../../apps/assistant/src/infrastructure/elevenlabs/tts.js';
import { ElevenLabsSttStream } from '../../apps/assistant/src/infrastructure/elevenlabs/stt-stream.js';
import { ElevenLabsFileStt } from '../../apps/assistant/src/infrastructure/elevenlabs/stt-file.js';
import { isFatalLinkError } from '../../apps/assistant/src/modules/calls/audio/realtime-bridge.js';
import { loadConfig } from '../../apps/assistant/src/bootstrap/config.js';

// The SDK's event names (its RealtimeEvents enum values); the test file lives outside the package that depends on the SDK.
const RealtimeEvents = {
  SESSION_STARTED: 'session_started',
  COMMITTED_TRANSCRIPT: 'committed_transcript',
  AUTH_ERROR: 'auth_error',
  CLOSE: 'close',
  INSUFFICIENT_AUDIO_ACTIVITY: 'insufficient_audio_activity',
} as const;

const body = (chunks: number[][], delayMs = 0) =>
  new ReadableStream<Uint8Array>({
    async start(c) {
      for (const ch of chunks) {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        c.enqueue(new Uint8Array(ch));
      }
      c.close();
    },
  });

const ttsClient = (make: (voice: string, req: any, opts: any) => Promise<ReadableStream<Uint8Array>>) => ({ textToSpeech: { stream: make } }) as any;

describe('ElevenLabsTts (official SDK, raw 24 kHz PCM)', () => {
  it('asks for pcm_24000 with the configured voice and model (nothing defaulted), and passes the language and voice settings', async () => {
    const seen: any[] = [];
    const tts = new ElevenLabsTts({
      client: ttsClient(async (voice, req, opts) => (seen.push({ voice, req, opts }), body([[1, 0, 2, 0]]))),
      voiceId: 'VOICE',
      model: 'eleven_v3',
      languageCode: 'uz',
      speed: 1.1,
    });
    const out = await tts.synthesize('Salom', 'uz');
    expect(out).toMatchObject({ rateHz: 24_000 });
    expect(Array.from(out.pcm)).toEqual([1, 0, 2, 0]);
    expect(seen[0]).toMatchObject({
      voice: 'VOICE',
      opts: { maxRetries: 0 }, // the SDK's own retries would hide a dead network behind long waits
      req: { text: 'Salom', modelId: 'eleven_v3', outputFormat: 'pcm_24000', languageCode: 'uz', voiceSettings: { speed: 1.1 } },
    });
  });

  it('hands chunks over as they arrive, always an even number of bytes (a chunk may end inside a 16-bit sample)', async () => {
    const tts = new ElevenLabsTts({ client: ttsClient(async () => body([[1, 2, 3], [4, 5], [6]])), voiceId: 'v', model: 'm' });
    const got: number[][] = [];
    await tts.synthesizeStream('x', 'uz', undefined, (c) => got.push(Array.from(c)));
    expect(got.every((c) => c.length % 2 === 0)).toBe(true);
    expect(got.flat()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('a provider error is readable and carries no key; an empty answer is an error', async () => {
    const bad = new ElevenLabsTts({
      client: ttsClient(async () => {
        throw Object.assign(new Error('x'), { statusCode: 401, body: { detail: { status: 'invalid_api_key', message: 'Invalid API key' } } });
      }),
      voiceId: 'v',
      model: 'm',
    });
    await expect(bad.synthesize('a', 'uz')).rejects.toThrow(/elevenlabs tts HTTP 401: Invalid API key/);
    const empty = new ElevenLabsTts({ client: ttsClient(async () => body([])), voiceId: 'v', model: 'm' });
    await expect(empty.synthesize('a', 'uz')).rejects.toThrow(/no audio/);
  });

  it('stops at once when aborted and does not time out on a healthy stream; a stalled one times out', async () => {
    const ac = new AbortController();
    const slow = new ElevenLabsTts({
      client: ttsClient(async () =>
        body(
          [
            [1, 0],
            [2, 0],
            [3, 0],
          ],
          30,
        ),
      ),
      voiceId: 'v',
      model: 'm',
    });
    const got: number[] = [];
    const run = slow.synthesizeStream('x', 'uz', ac.signal, (c) => got.push(c.length));
    setTimeout(() => ac.abort(), 45);
    await expect(run).rejects.toThrow(/aborted/);
    expect(got.length).toBeLessThan(3);
    const stalled = new ElevenLabsTts({
      client: ttsClient(async () => new ReadableStream<Uint8Array>({ start() {} })),
      voiceId: 'v',
      model: 'm',
      firstByteTimeoutMs: 40,
    });
    await expect(stalled.synthesize('x', 'uz')).rejects.toThrow(/no audio within 40 ms/);
  });
});

class FakeConn {
  handlers = new Map<string, (d: any) => void>();
  sent: Array<{ audioBase64: string; sampleRate?: number }> = [];
  commits = 0;
  closed = false;
  on(e: string, cb: (d: any) => void) {
    this.handlers.set(e, cb);
  }
  emit(e: string, d: any = {}) {
    this.handlers.get(e)?.(d);
  }
  send(d: { audioBase64: string; sampleRate?: number }) {
    this.sent.push(d);
  }
  commit() {
    this.commits++;
  }
  close() {
    this.closed = true;
  }
}

const sttFixture = (opts: { maxReconnects?: number } = {}) => {
  const conns: FakeConn[] = [];
  const connectArgs: any[] = [];
  const client = {
    speechToText: {
      realtime: {
        connect: async (a: any) => {
          connectArgs.push(a);
          const c = new FakeConn();
          conns.push(c);
          return c;
        },
      },
    },
  } as any;
  const stream = new ElevenLabsSttStream({ client, model: 'scribe_v2_realtime', language: 'uz', sampleRateHz: 16_000, ...opts });
  const finals: string[] = [];
  const errors: string[] = [];
  stream.onFinal((f) => finals.push(f.text));
  stream.onError((m) => errors.push(m));
  const tick = () => new Promise((r) => setTimeout(r, 5));
  return { stream, conns, connectArgs, finals, errors, tick };
};
const pcm = (ms: number) => new Uint8Array(Math.round((ms / 1000) * 16_000) * 2).fill(1);

describe('ElevenLabsSttStream (Scribe realtime, manual commit)', () => {
  it('connects with the configured model, pcm_16000 and manual commit; audio waits for session_started, then flows; a commit returns the final text', async () => {
    const f = sttFixture();
    await f.tick();
    expect(f.connectArgs[0]).toMatchObject({
      modelId: 'scribe_v2_realtime',
      audioFormat: 'pcm_16000',
      sampleRate: 16_000,
      languageCode: 'uz',
      commitStrategy: 'manual',
    });
    const c = f.conns[0]!;
    f.stream.sendAudio(pcm(300));
    expect(c.sent).toHaveLength(0); // not started yet
    expect(f.stream.commit()).toBe(true);
    c.emit(RealtimeEvents.SESSION_STARTED);
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toMatchObject({ sampleRate: 16_000 });
    expect(c.commits).toBe(1);
    c.emit(RealtimeEvents.COMMITTED_TRANSCRIPT, { text: 'salom dunyo' });
    expect(f.finals).toEqual(['salom dunyo']);
  });

  it('less than 100 ms is not committed', async () => {
    const f = sttFixture();
    await f.tick();
    f.conns[0]!.emit(RealtimeEvents.SESSION_STARTED);
    f.stream.sendAudio(pcm(50));
    expect(f.stream.commit()).toBe(false);
  });

  it('an interrupted utterance is committed on the server and its transcript is dropped when it arrives; the next one is delivered', async () => {
    const f = sttFixture();
    await f.tick();
    const c = f.conns[0]!;
    c.emit(RealtimeEvents.SESSION_STARTED);
    f.stream.sendAudio(pcm(400));
    f.stream.interrupt();
    expect(c.commits).toBe(1);
    c.emit(RealtimeEvents.COMMITTED_TRANSCRIPT, { text: 'cough' });
    expect(f.finals).toEqual([]);
    f.stream.sendAudio(pcm(400));
    f.stream.commit();
    c.emit(RealtimeEvents.COMMITTED_TRANSCRIPT, { text: 'real words' });
    expect(f.finals).toEqual(['real words']);
  });

  it('a rejected key ends recognition for the call with a message the call bridge treats as fatal (the AI would hear nothing)', async () => {
    const f = sttFixture();
    await f.tick();
    f.conns[0]!.emit(RealtimeEvents.AUTH_ERROR, { error: 'invalid key' });
    expect(f.errors.some((m) => isFatalLinkError(m))).toBe(true);
    expect(f.conns[0]!.closed).toBe(true);
  });

  it('a lost connection is re-opened; after repeated losses the recogniser is declared gone', async () => {
    const f = sttFixture({ maxReconnects: 1 });
    await f.tick();
    f.conns[0]!.emit(RealtimeEvents.CLOSE);
    await new Promise((r) => setTimeout(r, 260));
    expect(f.conns).toHaveLength(2);
    f.conns[1]!.emit(RealtimeEvents.CLOSE);
    expect(f.errors.some((m) => isFatalLinkError(m))).toBe(true);
  });

  it('a nothing-to-transcribe answer is an empty result, not a failure of the call', async () => {
    const f = sttFixture();
    await f.tick();
    const c = f.conns[0]!;
    c.emit(RealtimeEvents.SESSION_STARTED);
    f.stream.sendAudio(pcm(300));
    f.stream.commit();
    c.emit(RealtimeEvents.INSUFFICIENT_AUDIO_ACTIVITY, { error: 'quiet' });
    expect(f.errors.some((m) => isFatalLinkError(m))).toBe(false);
  });
});

describe('ElevenLabsSttStream: a connection that never opens', () => {
  it('counts as a failed attempt (reopened, then declared gone), and a connection arriving late is closed', async () => {
    const late: FakeConn[] = [];
    const client = {
      speechToText: {
        realtime: {
          connect: () =>
            new Promise((resolve) =>
              setTimeout(() => {
                const c = new FakeConn();
                late.push(c);
                resolve(c);
              }, 120),
            ),
        },
      },
    } as any;
    const stream = new ElevenLabsSttStream({ client, model: 'm', language: 'uz', sampleRateHz: 16_000, connectTimeoutMs: 30, maxReconnects: 0 });
    const errors: string[] = [];
    stream.onError((m) => errors.push(m));
    await new Promise((r) => setTimeout(r, 250));
    expect(errors.some((m) => isFatalLinkError(m))).toBe(true);
    expect(late.length).toBeGreaterThan(0);
    expect(late.every((c) => c.closed)).toBe(true);
  });
});

describe('ElevenLabsFileStt (voice notes)', () => {
  const mk = (res: unknown, seen: any[] = []) =>
    new ElevenLabsFileStt({
      client: {
        speechToText: {
          convert: async (req: any) => {
            seen.push(req);
            if (res instanceof Error) throw res;
            return res;
          },
        },
      } as any,
      model: 'scribe_v2',
      language: 'uz',
    });

  it('sends the voice note as it is with the configured model and language, and reads the text', async () => {
    const seen: any[] = [];
    const t = await mk({ text: ' Ertaga soat 9 da uchrashuv ', languageCode: 'uzb', languageProbability: 0.97 }, seen).transcribe({
      bytes: new Uint8Array([1, 2, 3]),
      mime: 'audio/ogg; codecs=opus',
      durationSeconds: 2,
    });
    expect(t).toMatchObject({ text: 'Ertaga soat 9 da uchrashuv', confidence: 0.97, language: 'uzb' });
    expect(seen[0]).toMatchObject({ modelId: 'scribe_v2', languageCode: 'uz', diarize: false });
    expect((seen[0].file as File).name).toBe('voice.ogg');
  });

  it('an empty transcript and a provider error are errors the intake reports to the owner', async () => {
    await expect(mk({ text: '  ' }).transcribe({ bytes: new Uint8Array([1]), mime: 'audio/ogg', durationSeconds: 1 })).rejects.toThrow(/no transcript/);
    await expect(
      mk(Object.assign(new Error('quota'), { statusCode: 429 })).transcribe({ bytes: new Uint8Array([1]), mime: 'audio/ogg', durationSeconds: 1 }),
    ).rejects.toThrow(/elevenlabs stt HTTP 429/);
  });
});

describe('config: ElevenLabs', () => {
  const base = { DATABASE_URL: 'postgres://x/y' };
  it('needs the key, the voice and the model (nothing is defaulted) and a thinking model', () => {
    expect(() => loadConfig({ ...base, TTS_PROVIDER: 'elevenlabs' })).toThrow(/ELEVENLABS_API_KEY/);
    expect(() => loadConfig({ ...base, TTS_PROVIDER: 'elevenlabs', ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE_ID: 'v', AI_VOICE_PROVIDER: 'gemini' })).toThrow(
      /ELEVENLABS_TTS_MODEL/,
    );
    expect(() => loadConfig({ ...base, TTS_PROVIDER: 'elevenlabs', ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE_ID: 'v', ELEVENLABS_TTS_MODEL: 'm' })).toThrow(
      /AI_VOICE_PROVIDER/,
    );
    const c = loadConfig({
      ...base,
      TTS_PROVIDER: ' ElevenLabs ',
      STT_PROVIDER: 'elevenlabs',
      ELEVENLABS_API_KEY: 'k',
      ELEVENLABS_VOICE_ID: 'v',
      ELEVENLABS_TTS_MODEL: 'm',
      ELEVENLABS_STT_MODEL: 'scribe_v2_realtime',
      AI_VOICE_PROVIDER: 'gemini',
    });
    expect(c).toMatchObject({ TTS_PROVIDER: 'elevenlabs', STT_PROVIDER: 'elevenlabs', ELEVENLABS_LANGUAGE_CODE: 'uz', ELEVENLABS_STT_CALLS: true });
  });
  it('a stray character after the language code is refused with a pointer to .env, not sent to the service', () => {
    expect(() => loadConfig({ ...base, ELEVENLABS_LANGUAGE_CODE: 'uz)' })).toThrow(/ELEVENLABS_LANGUAGE_CODE/);
    expect(loadConfig({ ...base, ELEVENLABS_LANGUAGE_CODE: ' uz ' }).ELEVENLABS_LANGUAGE_CODE).toBe('uz');
  });
  it('live-call recognition by ElevenLabs needs its model and a speaking voice', () => {
    const e = { ...base, STT_PROVIDER: 'elevenlabs', ELEVENLABS_API_KEY: 'k' };
    expect(() => loadConfig(e)).toThrow(/ELEVENLABS_STT_MODEL/);
    expect(loadConfig({ ...e, ELEVENLABS_STT_CALLS: 'false' }).STT_PROVIDER).toBe('elevenlabs'); // voice notes only
  });
});
