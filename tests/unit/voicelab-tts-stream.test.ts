import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/assistant/src/bootstrap/config.js';
import { VoiceLabMouthLink, type TextBrain } from '../../apps/assistant/src/infrastructure/voicelab/mouth-link.js';
import { TurnTimer } from '../../apps/assistant/src/infrastructure/voicelab/turn-timer.js';
import { VoiceLabTtsStream, type StreamingSynthesizer } from '../../apps/assistant/src/infrastructure/voicelab/tts-stream.js';

class FakeSocket extends EventEmitter {
  sent: string[] = [];
  closed = false;
  send(x: string) {
    this.sent.push(x);
  }
  close() {
    this.closed = true;
  }
  say(x: object) {
    this.emit('message', Buffer.from(JSON.stringify(x)), false);
  }
  audio(n: number) {
    this.emit('message', Buffer.alloc(n, 1), true);
  }
  json() {
    return this.sent.map((x) => JSON.parse(x) as Record<string, unknown>);
  }
}

const mk = (o: { speed?: number; maxConcurrent?: number; firstAudioTimeoutMs?: number; chunkTimeoutMs?: number } = {}) => {
  const socks: Array<{ url: string; headers: Record<string, string>; sock: FakeSocket }> = [];
  const tts = new VoiceLabTtsStream({
    apiKey: 'sekret-key',
    voiceId: 'v-1',
    socketFactory: (url, headers) => {
      const sock = new FakeSocket();
      socks.push({ url, headers, sock });
      return sock as never;
    },
    ...o,
  });
  return { tts, socks };
};

describe('VoiceLabTtsStream (realtime TTS protocol)', () => {
  it('authenticates with xvl-api-key, waits for ready, sends exactly one request and hands audio on as it arrives', async () => {
    const { tts, socks } = mk();
    const got: number[] = [];
    const p = tts.synthesizeStream('Salom!', 'uz', undefined, (c) => got.push(c.length));
    const { url, headers, sock } = socks[0]!;
    expect(url).toBe('wss://api.voicelab.uz/v1/tts/stream');
    expect(headers).toEqual({ 'xvl-api-key': 'sekret-key' });
    expect(sock.sent).toHaveLength(0); // nothing before ready
    sock.say({ event: 'ready' });
    expect(sock.json()).toEqual([{ text: 'Salom!', language: 'uz', voice_id: 'v-1', speed: 1 }]);
    sock.audio(4800);
    expect(got).toEqual([4800]); // delivered at once, before done
    sock.audio(2400);
    expect(got).toEqual([4800, 2400]);
    sock.say({ event: 'done' });
    await p;
    expect(sock.closed).toBe(true);
    expect(sock.sent).toHaveLength(1); // one request per connection
  });

  it('keeps 16-bit samples whole when a chunk ends in the middle of one', async () => {
    const { tts, socks } = mk();
    const got: number[] = [];
    const p = tts.synthesizeStream('Salom', 'uz', undefined, (c) => got.push(c.length));
    const { sock } = socks[0]!;
    sock.say({ event: 'ready' });
    sock.audio(5); // 2 samples + 1 stray byte
    sock.audio(5); // the stray byte + 5 = 6 -> 3 samples
    sock.say({ event: 'done' });
    await p;
    expect(got).toEqual([4, 6]);
    expect(got.every((n) => n % 2 === 0)).toBe(true);
  });

  it('clamps the speed to 0.5-2.0', async () => {
    const { tts, socks } = mk({ speed: 5 });
    const p = tts.synthesizeStream('Salom', 'uz', undefined, () => undefined);
    socks[0]!.sock.say({ event: 'ready' });
    expect(socks[0]!.sock.json()[0]!.speed).toBe(2);
    socks[0]!.sock.say({ event: 'done' });
    await p;
  });

  it('an error event rejects without leaking the key; a close before done rejects; text over 8 KiB is refused', async () => {
    const a = mk();
    const p1 = a.tts.synthesizeStream('Salom', 'uz', undefined, () => undefined);
    a.socks[0]!.sock.say({ event: 'error', code: 'forbidden', message: 'bad key sekret-key' });
    await expect(p1).rejects.toThrow(/forbidden: bad key \*\*\*/);

    const b = mk();
    const p2 = b.tts.synthesizeStream('Salom', 'uz', undefined, () => undefined);
    b.socks[0]!.sock.say({ event: 'ready' });
    b.socks[0]!.sock.audio(100);
    b.socks[0]!.sock.emit('close', 1006);
    await expect(p2).rejects.toThrow(/in the middle of the audio/);

    await expect(mk().tts.synthesizeStream('x'.repeat(9000), 'uz', undefined, () => undefined)).rejects.toThrow(/8 KiB/);
  });

  it('abort sends interrupt, closes the socket and rejects', async () => {
    const { tts, socks } = mk();
    const ac = new AbortController();
    const p = tts.synthesizeStream('Salom', 'uz', ac.signal, () => undefined);
    const { sock } = socks[0]!;
    sock.say({ event: 'ready' });
    ac.abort();
    await expect(p).rejects.toThrow('aborted');
    expect(sock.json().some((j) => j.action === 'interrupt')).toBe(true);
    expect(sock.closed).toBe(true);
  });

  it('times out waiting for the first audio and for a stalled chunk', async () => {
    const a = mk({ firstAudioTimeoutMs: 20 });
    await expect(a.tts.synthesizeStream('Salom', 'uz', undefined, () => undefined)).rejects.toThrow(/no audio within 20 ms/);
    const b = mk({ chunkTimeoutMs: 20 });
    const p = b.tts.synthesizeStream('Salom', 'uz', undefined, () => undefined);
    b.socks[0]!.sock.say({ event: 'ready' });
    b.socks[0]!.sock.audio(100);
    await expect(p).rejects.toThrow(/no audio chunk within 20 ms/);
  });

  it('opens at most maxConcurrent connections; the rest wait', async () => {
    const { tts, socks } = mk({ maxConcurrent: 1 });
    const p1 = tts.synthesizeStream('Bir', 'uz', undefined, () => undefined);
    const p2 = tts.synthesizeStream('Ikki', 'uz', undefined, () => undefined);
    await Promise.resolve();
    expect(socks).toHaveLength(1);
    socks[0]!.sock.say({ event: 'done' });
    await p1;
    await Promise.resolve();
    expect(socks).toHaveLength(2);
    socks[1]!.sock.say({ event: 'done' });
    await p2;
  });
});

class FakeBrain implements TextBrain {
  inputRateHz = 16000;
  outputRateHz = 24000;
  textCb: (d: string, done: boolean) => void = () => undefined;
  onText(cb: (d: string, done: boolean) => void) {
    this.textCb = cb;
  }
  onToolCall() {}
  onSpeechStarted() {}
  sendAudio() {}
  respond() {}
  interrupt() {}
  onResponseStart() {}
  onAudio() {}
  onTranscript() {}
  onError() {}
  sendToolResult() {}
  close() {}
}

const waitFor = async (ok: () => boolean, ms = 2000) => {
  for (const start = Date.now(); !ok() && Date.now() - start < ms;) await new Promise((r) => setTimeout(r, 5));
};

/** A scriptable streaming synthesizer: each call is one "connection" the test drives by hand. */
function fakeStream() {
  const calls: Array<{ text: string; signal?: AbortSignal | undefined; chunk: (n: number) => void; done: () => void; fail: (m: string) => void }> = [];
  const s: StreamingSynthesizer = {
    synthesizeStream: (text, _l, signal, onChunk) =>
      new Promise<void>((resolve, reject) => {
        calls.push({
          text,
          signal,
          chunk: (n) => onChunk(new Uint8Array(n)),
          done: () => resolve(),
          fail: (m) => reject(new Error(m)),
        });
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
  };
  return { s, calls };
}

describe('VoiceLabMouthLink with streaming synthesis', () => {
  const mkLink = (restImpl?: (t: string) => Promise<{ pcm: Uint8Array; rateHz: number }>) => {
    const brain = new FakeBrain();
    const f = fakeStream();
    const rest: string[] = [];
    const tts = {
      synthesize: async (t: string) => {
        rest.push(t);
        return restImpl ? restImpl(t) : { pcm: new Uint8Array(4800), rateHz: 24000 };
      },
    };
    const lines: string[] = [];
    const errors: string[] = [];
    const timerLines: string[] = [];
    const timer = new TurnTimer((l) => timerLines.push(l));
    const link = new VoiceLabMouthLink(brain, tts, { stream: f.s, timer, log: (l) => lines.push(l) });
    const audio: number[] = [];
    link.onAudio((p) => audio.push(p.length));
    link.onError((m) => errors.push(m));
    return { brain, link, f, rest, audio, lines, errors, timer, timerLines };
  };

  it('plays the first chunk at once, before the synthesis is done, and keeps sentence order across parallel connections', async () => {
    const { brain, f, audio } = mkLink();
    brain.textCb('Birinchi gap. Ikkinchi gap. ', false);
    await waitFor(() => f.calls.length === 2); // both sentences synthesise in parallel on their own connections
    f.calls[1]!.chunk(4800); // the second sentence is ready first ...
    await new Promise((r) => setTimeout(r, 20));
    expect(audio).toEqual([]); // ... but it must wait for the first
    f.calls[0]!.chunk(4800);
    await waitFor(() => audio.length >= 1);
    expect(audio).toEqual([4800]); // first sentence is playing though its synthesis has not finished
    f.calls[0]!.done();
    await waitFor(() => audio.length >= 2);
    expect(audio).toEqual([4800, 4800]); // then the buffered second sentence
  });

  it('records first model text, first synthesised chunk and first played audio', async () => {
    const { brain, f, timer, timerLines } = mkLink();
    timer.mark('speechEnd');
    timer.mark('commit');
    timer.mark('final');
    brain.textCb('Salom, dunyo.', true);
    await waitFor(() => f.calls.length >= 1);
    f.calls[0]!.chunk(4800);
    await waitFor(() => timerLines.length === 1);
    expect(timerLines[0]).toContain('speech synthesis first chunk');
    expect(timerLines[0]).toContain('first chunk -> first audio');
    expect(timerLines[0]).toMatch(/final -> first model text \d+ ms/);
  });

  it('barge-in aborts the open streams, clears the queue and drops audio that arrives late', async () => {
    const { brain, link, f, audio } = mkLink();
    brain.textCb('Uzun gap. Yana gap. ', false);
    await waitFor(() => f.calls.length === 2);
    f.calls[0]!.chunk(4800);
    await waitFor(() => audio.length === 1);
    link.interrupt(100);
    expect(f.calls.every((c) => c.signal?.aborted)).toBe(true);
    f.calls[0]!.chunk(4800); // late audio of the old answer
    f.calls[1]!.chunk(4800);
    await new Promise((r) => setTimeout(r, 30));
    expect(audio).toEqual([4800]);
  });

  it('a stream that fails before any audio is voiced by the REST synthesis instead', async () => {
    const { brain, f, rest, audio, lines, errors } = mkLink();
    brain.textCb('Salom dunyo.', true);
    await waitFor(() => f.calls.length === 1);
    f.calls[0]!.fail('ws closed');
    await waitFor(() => audio.length >= 1);
    expect(rest).toEqual(['Salom dunyo.']);
    expect(audio).toEqual([4800]);
    expect(errors).toEqual([]);
    expect(lines.some((l) => l.includes('streaming synthesis failed before any audio'))).toBe(true);
  });

  it('a stream that dies after part of the sentence was voiced is reported and not repeated', async () => {
    const { brain, f, rest, audio, errors } = mkLink();
    brain.textCb('Salom dunyo.', true);
    await waitFor(() => f.calls.length === 1);
    f.calls[0]!.chunk(4800);
    await waitFor(() => audio.length === 1);
    f.calls[0]!.fail('connection lost');
    await waitFor(() => errors.length === 1);
    expect(errors[0]).toContain('connection lost');
    expect(rest).toEqual([]); // no REST replay of a sentence the caller already half heard
    expect(audio).toEqual([4800]);
  });

  it('stock reaction words and over-long text keep using the REST synthesis', async () => {
    const brain = new FakeBrain();
    const f = fakeStream();
    const rest: string[] = [];
    const tts = {
      synthesize: async (t: string) => {
        rest.push(t);
        return { pcm: new Uint8Array(4800), rateHz: 24000 };
      },
    };
    const link = new VoiceLabMouthLink(brain, tts, { stream: f.s });
    const audio: number[] = [];
    link.onAudio((p) => audio.push(p.length));
    brain.textCb(`${'a'.repeat(9000)}.`, true);
    await waitFor(() => audio.length >= 1);
    expect(f.calls).toHaveLength(0);
    expect(rest).toHaveLength(1);
  });
});

describe('streaming TTS configuration', () => {
  it('is off unless asked for', () => {
    const base = { NODE_ENV: 'test', DATABASE_URL: 'postgres://x', TELEGRAM_API_ID: '1', TELEGRAM_API_HASH: 'abcdefgh1234' } as Record<string, string>;
    expect(loadConfig(base).VOICELAB_TTS_STREAM).toBe(false);
    expect(loadConfig({ ...base, VOICELAB_TTS_STREAM: 'true' }).VOICELAB_TTS_STREAM).toBe(true);
  });
});
