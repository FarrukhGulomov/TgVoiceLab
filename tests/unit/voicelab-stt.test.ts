import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/assistant/src/bootstrap/config.js';
import { AutoGain } from '../../apps/assistant/src/infrastructure/audio/auto-gain.js';
import { VoiceLabEars, type UserTextBrain } from '../../apps/assistant/src/infrastructure/voicelab/stt-ears.js';
import { VoiceLabFileStt, fileNameFor, readJobId, readText } from '../../apps/assistant/src/infrastructure/voicelab/stt-file.js';
import { VoiceLabSttStream, type SttStream } from '../../apps/assistant/src/infrastructure/voicelab/stt-stream.js';
import { TurnTimer } from '../../apps/assistant/src/infrastructure/voicelab/turn-timer.js';
import { wer } from '../../apps/assistant/src/infrastructure/voicelab/wer.js';

class FakeSocket extends EventEmitter {
  sent: Array<string | Uint8Array> = [];
  closed = false;
  send(x: string | Uint8Array) {
    this.sent.push(x);
  }
  close() {
    this.closed = true;
  }
  say(x: object) {
    this.emit('message', Buffer.from(JSON.stringify(x)), false);
  }
  json() {
    return this.sent.filter((x): x is string => typeof x === 'string').map((x) => JSON.parse(x) as Record<string, unknown>);
  }
}

const frames = (ms: number, amp: number, rate = 16000) => {
  const b = new Uint8Array(((rate * ms) / 1000) * 2);
  const v = new DataView(b.buffer);
  for (let i = 0; i < b.length / 2; i++) v.setInt16(i * 2, i % 2 ? amp : -amp, true);
  return b;
};

describe('VoiceLabSttStream (realtime protocol)', () => {
  const mk = () => {
    const socks: Array<{ url: string; headers: Record<string, string>; sock: FakeSocket }> = [];
    const s = new VoiceLabSttStream({
      apiKey: 'sekret-key',
      url: 'wss://api.voicelab.uz/v1/stt/stream',
      language: 'uz',
      sampleRateHz: 16000,
      socketFactory: (url, headers) => {
        const sock = new FakeSocket();
        socks.push({ url, headers, sock });
        return sock as never;
      },
    });
    return { s, socks };
  };

  it('authenticates with xvl-api-key, waits for ready, then starts the session and only then sends audio', () => {
    const { s, socks } = mk();
    const { sock, headers, url } = socks[0]!;
    expect(url).toBe('wss://api.voicelab.uz/v1/stt/stream');
    expect(headers).toEqual({ 'xvl-api-key': 'sekret-key' });
    s.sendAudio(frames(200, 3000)); // before ready: held
    expect(sock.sent).toHaveLength(0);
    sock.say({ event: 'ready' });
    expect(sock.json()[0]).toEqual({ type: 'start', language: 'uz', audio_format: 'pcm_s16le', sample_rate: 16000, channels: 1, word_timestamps: true });
    expect(sock.sent[0]).toEqual(expect.any(String)); // start comes first
    expect(sock.sent[1]).toBeInstanceOf(Uint8Array); // then the held audio, raw PCM, no header
    expect((sock.sent[1] as Uint8Array).length).toBe(6400);
  });

  it('commits only 100 ms or more, reports final and error events separately, and never leaks the key', () => {
    const { s, socks } = mk();
    const sock = socks[0]!.sock;
    sock.say({ event: 'ready' });
    const finals: string[] = [];
    const errors: string[] = [];
    s.onFinal((f) => finals.push(f.text));
    s.onError((m) => errors.push(m));
    s.sendAudio(frames(60, 3000));
    expect(s.commit()).toBe(false); // 60 ms is too short
    s.sendAudio(frames(100, 3000));
    expect(s.commit()).toBe(true);
    expect(sock.json().at(-1)).toEqual({ type: 'commit' });
    sock.say({ event: 'final', text: 'Salom dunyo', language: 'uz' });
    sock.say({ event: 'error', code: 'bad', message: 'oops sekret-key' });
    expect(finals).toEqual(['Salom dunyo']);
    expect(errors).toEqual(['stt error: bad: oops ***']);
  });

  it('interrupt cancels the work in flight and drops audio that never left', () => {
    const { s, socks } = mk();
    const sock = socks[0]!.sock;
    s.sendAudio(frames(200, 3000)); // still waiting for ready
    s.interrupt();
    sock.say({ event: 'ready' });
    expect(sock.sent.filter((x) => x instanceof Uint8Array)).toHaveLength(0);
    expect(sock.json().some((j) => j.action === 'interrupt')).toBe(true);
  });

  it('reconnects after an unexpected close (twice at most) and then reports it', () => {
    const { s, socks } = mk();
    const errors: string[] = [];
    s.onError((m) => errors.push(m));
    socks[0]!.sock.emit('close', 1011, Buffer.from('boom'));
    expect(socks).toHaveLength(2);
    socks[1]!.sock.emit('close', 1006, Buffer.from(''));
    expect(socks).toHaveLength(3);
    socks[2]!.sock.emit('close', 1006, Buffer.from(''));
    expect(errors).toHaveLength(1);
    s.close();
  });
});

class FakeStream implements SttStream {
  audio: number[] = [];
  commits = 0;
  interrupts = 0;
  closed = false;
  finalCb: (f: { text: string }) => void = () => undefined;
  pending = 0;
  sendAudio(pcm: Uint8Array) {
    this.audio.push(pcm.length);
    this.pending += pcm.length / 32;
  }
  commit() {
    if (this.pending < 100) return false;
    this.pending = 0;
    this.commits++;
    return true;
  }
  interrupt() {
    this.pending = 0;
    this.interrupts++;
  }
  onFinal(cb: (f: { text: string }) => void) {
    this.finalCb = cb;
  }
  onError() {}
  close() {
    this.closed = true;
  }
}

class FakeBrain implements UserTextBrain {
  inputRateHz = 24000;
  outputRateHz = 24000;
  userTexts: string[] = [];
  textCb: (d: string, done: boolean) => void = () => undefined;
  sendUserText(t: string) {
    this.userTexts.push(t);
  }
  onText(cb: (d: string, done: boolean) => void) {
    this.textCb = cb;
  }
  sendAudio() {
    throw new Error('the model must never receive the caller audio');
  }
  respond() {}
  interrupt() {}
  onResponseStart() {}
  onAudio() {}
  onSpeechStarted() {}
  onTranscript() {}
  onError() {}
  onToolCall() {}
  sendToolResult() {}
  close() {}
}

describe('VoiceLabEars', () => {
  const mk = (o: ConstructorParameters<typeof VoiceLabEars>[2] = {}) => {
    const brain = new FakeBrain();
    const stream = new FakeStream();
    const ears = new VoiceLabEars(brain, stream, { silenceMs: 600, ...o });
    const texts: string[] = [];
    const heard: string[] = [];
    const speech: number[] = [];
    ears.onText((d) => texts.push(d));
    ears.onTranscript((who, t) => who === 'caller' && heard.push(t));
    ears.onSpeechStarted(() => speech.push(1));
    return { brain, stream, ears, texts, heard, speech };
  };
  const talk = (ears: VoiceLabEars, ms: number) => {
    for (let i = 0; i < ms / 100; i++) ears.sendAudio(frames(100, 3000));
  };
  const hush = (ears: VoiceLabEars, ms: number) => {
    for (let i = 0; i < ms / 100; i++) ears.sendAudio(frames(100, 20));
  };

  it('streams an utterance, commits after the silence threshold, and gives the final transcript to the model as text', () => {
    const { ears, stream, brain, heard, speech } = mk();
    expect(ears.inputRateHz).toBe(16000);
    talk(ears, 1000);
    hush(ears, 500);
    expect(stream.commits).toBe(0); // 500 ms < 600 ms
    hush(ears, 100);
    expect(stream.commits).toBe(1);
    expect(speech).toHaveLength(1);
    stream.finalCb({ text: '  O‘n ming dollar   bo‘ladi ' });
    expect(brain.userTexts).toEqual(['O‘n ming dollar bo‘ladi']);
    expect(heard).toEqual(['O‘n ming dollar bo‘ladi']);
  });

  it('throws away a click instead of making it a turn, and ignores empty transcripts', () => {
    const { ears, stream, brain } = mk();
    talk(ears, 100); // 100 ms: below the minimum speech
    hush(ears, 700);
    expect(stream.commits).toBe(0);
    expect(stream.interrupts).toBe(1);
    stream.finalCb({ text: '   ' });
    stream.finalCb({ text: '...' });
    expect(brain.userTexts).toEqual([]);
  });

  it('cuts a very long speech before the 35 s limit and goes on with the next utterance', () => {
    const { ears, stream } = mk();
    talk(ears, 31000);
    expect(stream.commits).toBe(1);
    expect(stream.pending).toBeLessThan(35000 * 32);
    talk(ears, 2000);
    hush(ears, 700);
    expect(stream.commits).toBe(2);
  });

  it('when the caller talks over a running answer, the rest of that answer is dropped until the next question', () => {
    const { ears, brain, texts, stream } = mk();
    brain.textCb('Narxi o‘n ming', false); // the model is writing
    expect(texts).toEqual(['Narxi o‘n ming']);
    talk(ears, 800); // the caller interrupts
    brain.textCb(' dollar bo‘ladi.', false);
    brain.textCb('', true);
    expect(texts).toEqual(['Narxi o‘n ming']);
    hush(ears, 700);
    stream.finalCb({ text: 'Yo‘q, kamroq' });
    brain.textCb('Tushundim.', false);
    expect(texts).toEqual(['Narxi o‘n ming', 'Tushundim.']);
  });

  it('times the turn: speech end (the moment the voice stopped) -> commit -> final', () => {
    let now = 1000;
    const lines: string[] = [];
    const timer = new TurnTimer(
      (l) => lines.push(l),
      () => now,
    );
    const { ears, stream } = mk({ timer, now: () => now });
    talk(ears, 1000);
    now = 2000;
    hush(ears, 700); // silence ends the utterance 700 ms after the voice stopped
    expect(timer.has('commit')).toBe(true);
    now = 2400;
    stream.finalCb({ text: 'Salom' });
    now = 2900;
    timer.mark('firstText');
    timer.mark('ttsStart');
    now = 3400;
    timer.mark('ttsDone');
    now = 3500;
    timer.mark('firstAudio');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('speech end -> commit 600 ms'); // 600 ms of silence were waited
    expect(lines[0]).toContain('commit -> final text 400 ms');
    expect(lines[0]).toContain('final -> first model text 500 ms');
    expect(lines[0]).toContain('speech synthesis 500 ms');
    expect(lines[0]).toContain('TOTAL speech end -> first audio 2100 ms');
  });
});

describe('TurnTimer', () => {
  it('ignores marks outside a turn and prints nothing without a recognised final', () => {
    const lines: string[] = [];
    const t = new TurnTimer((l) => lines.push(l));
    t.mark('firstText');
    t.mark('firstAudio');
    t.mark('speechEnd');
    t.mark('firstAudio'); // no commit/final yet
    expect(lines).toEqual([]);
  });
});

describe('VoiceLabFileStt (audio files)', () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const mk = (answers: Array<{ status: number; body: unknown }>) => {
    calls.length = 0;
    return new VoiceLabFileStt({
      apiKey: 'sekret-key',
      pollIntervalMs: 1,
      sleep: async () => undefined,
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        const a = answers.shift()!;
        return new Response(JSON.stringify(a.body), { status: a.status });
      }) as never,
    });
  };

  it('uploads as multipart with a Bearer key and an idempotency key, polls until completed and returns the transcript', async () => {
    const stt = mk([
      { status: 202, body: { id: 'job-1', status: 'queued' } },
      { status: 200, body: { id: 'job-1', status: 'processing' } },
      { status: 200, body: { id: 'job-1', status: 'completed', text: 'Ertaga soat o‘nda eslat' } },
    ]);
    const r = await stt.transcribe({ bytes: new Uint8Array([1, 2, 3]), mime: 'audio/ogg; codecs=opus', durationSeconds: 3 });
    expect(r.text).toBe('Ertaga soat o‘nda eslat');
    expect(calls[0]!.url).toBe('https://api.voicelab.uz/v1/stt');
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h.Authorization).toBe('Bearer sekret-key');
    expect(h['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    const form = calls[0]!.init.body as FormData;
    expect(form.get('language')).toBe('uz');
    expect(form.get('include_speakers')).toBe('false');
    expect((form.get('audio') as File).name).toBe('voice.ogg');
    expect(calls[1]!.url).toBe('https://api.voicelab.uz/v1/stt/transcriptions/job-1');
  });

  it('reports failures without echoing the key or any content', async () => {
    await expect(
      mk([{ status: 403, body: { error: 'missing stt:write sekret-key' } }]).transcribe({ bytes: new Uint8Array(1), mime: 'audio/ogg', durationSeconds: 1 }),
    ).rejects.toThrow(/HTTP 403.*\*\*\*/);
    await expect(mk([{ status: 202, body: { weird: 1 } }]).transcribe({ bytes: new Uint8Array(1), mime: 'audio/ogg', durationSeconds: 1 })).rejects.toThrow(
      /no job id.*weird/,
    );
    await expect(
      mk([
        { status: 202, body: { id: 'x' } },
        { status: 200, body: { status: 'failed' } },
      ]).transcribe({ bytes: new Uint8Array(1), mime: 'audio/ogg', durationSeconds: 1 }),
    ).rejects.toThrow(/job failed/);
  });

  it('reads the likely spellings of the job id and the transcript, and names files by their type', () => {
    expect(readJobId({ data: { job_id: 'a' } })).toBe('a');
    expect(readText({ result: { segments: [{ text: 'bir' }, { text: 'ikki' }] } })?.text).toBe('bir ikki');
    expect(readText({ status: 'completed' })).toBeUndefined();
    expect(fileNameFor('audio/ogg')).toBe('voice.ogg');
    expect(fileNameFor('audio/mpeg')).toBe('voice.mp3');
    expect(fileNameFor('audio/webm;codecs=opus')).toBe('voice.webm');
    expect(fileNameFor('audio/x-m4a')).toBe('voice.m4a');
  });
});

describe('word error rate', () => {
  it('normalises case, punctuation and apostrophes, and counts substitutions, insertions and deletions', () => {
    expect(wer("Ertaga soat o'nda eslat.", 'ertaga soat o‘nda eslat')).toBe(0);
    expect(wer('bir ikki uch', 'bir uch')).toBeCloseTo(1 / 3);
    expect(wer('bir ikki', 'bir ikki uch to‘rt')).toBe(1);
    expect(wer('', '')).toBe(0);
    expect(wer('', 'x')).toBe(1);
  });
});

describe('AutoGain', () => {
  it('raises quiet speech, leaves loud speech and noise alone', () => {
    const peak = (b: Uint8Array) =>
      Math.max(...Array.from({ length: b.length / 2 }, (_, i) => Math.abs(new DataView(b.buffer, b.byteOffset).getInt16(i * 2, true))));
    const q = new AutoGain();
    let out = new Uint8Array();
    for (let i = 0; i < 20; i++) out = q.process(frames(100, 600));
    expect(peak(out)).toBeGreaterThan(2400);
    const l = new AutoGain();
    for (let i = 0; i < 20; i++) out = l.process(frames(100, 6000));
    expect(peak(out)).toBe(6000);
    const n = new AutoGain();
    expect(peak(n.process(frames(100, 40)))).toBe(40);
  });
});

describe('VoiceLab STT configuration', () => {
  const base = { DATABASE_URL: 'postgres://x', STT_PROVIDER: 'voicelab', VOICELAB_API_KEY: 'k' };
  it('is off by default, needs the key, and live-call use needs the VoiceLab voice when calls are on', () => {
    expect(loadConfig({ DATABASE_URL: 'postgres://x' }).STT_PROVIDER).toBeUndefined();
    expect(() => loadConfig({ ...base })).not.toThrow();
    expect(() => loadConfig({ ...base, VOICELAB_API_KEY: '' })).toThrow(/VOICELAB_API_KEY/);
    const c = loadConfig({ ...base });
    expect(c.VOICELAB_STT_SILENCE_MS).toBe(600);
    expect(c.VOICELAB_STT_LANGUAGE).toBe('uz');
    expect(() => loadConfig({ ...base, VOICELAB_STT_SILENCE_MS: '100' })).toThrow();
  });
});
