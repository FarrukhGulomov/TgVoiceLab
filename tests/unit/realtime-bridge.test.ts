import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { CallHandle, PcmFrame } from '@tgvl/contracts';
import { RealtimeCallBridge, type RealtimeLink } from '../../apps/assistant/src/modules/calls/audio/realtime-bridge.js';
import { OpenAiRealtimeLink, sessionUpdate } from '../../apps/assistant/src/infrastructure/openai/realtime.js';

const FRAME = 960;
const flush = () => new Promise((r) => setTimeout(r, 5));

class FakeLink implements RealtimeLink {
  sampleRateHz = 24000;
  sent: Uint8Array[] = [];
  responses: Array<string | undefined> = [];
  cancels = 0;
  closed = false;
  audio?: (p: Uint8Array) => void;
  speech?: () => void;
  transcript?: (w: 'assistant' | 'caller', t: string) => void;
  error?: (m: string) => void;
  sendAudio(p: Uint8Array) {
    this.sent.push(p);
  }
  respond(i?: string) {
    this.responses.push(i);
  }
  cancelResponse() {
    this.cancels++;
  }
  onAudio(cb: (p: Uint8Array) => void) {
    this.audio = cb;
  }
  onSpeechStarted(cb: () => void) {
    this.speech = cb;
  }
  onTranscript(cb: (w: 'assistant' | 'caller', t: string) => void) {
    this.transcript = cb;
  }
  onError(cb: (m: string) => void) {
    this.error = cb;
  }
  close() {
    this.closed = true;
  }
}

function fakeHandle() {
  const sent: PcmFrame[] = [];
  const queue: PcmFrame[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  const incoming = (async function* () {
    for (;;) {
      while (queue.length) yield queue.shift()!;
      if (done) return;
      await new Promise<void>((r) => (wake = r));
    }
  })();
  let flushed = 0;
  const handle = {
    callId: 'call-1',
    incomingAudio: incoming,
    events: (async function* () {})(),
    sendAudio: async (f: PcmFrame) => void sent.push(f),
    flushOutput: async () => void flushed++,
    end: async () => undefined,
  } as unknown as CallHandle;
  return {
    handle,
    sent,
    push: (samples: Uint8Array) => {
      queue.push({ callId: 'call-1', sequence: 0, monotonicTimestampUs: 0, sampleRateHz: 48000, channels: 1, encoding: 's16le', samples });
      wake?.();
    },
    flushed: () => flushed,
    finish: () => {
      done = true;
      wake?.();
    },
  };
}

const tone = (bytes: number, amp = 8000) => {
  const b = new Uint8Array(bytes);
  const v = new DataView(b.buffer);
  for (let i = 0; i < bytes / 2; i++) v.setInt16(i * 2, Math.round(Math.sin(i / 5) * amp), true);
  return b;
};

describe('RealtimeCallBridge', () => {
  it('forwards caller audio to the model resampled to the model rate (48k -> 24k halves the bytes)', async () => {
    const h = fakeHandle();
    const link = new FakeLink();
    const b = new RealtimeCallBridge(h.handle, link);
    b.start();
    for (let i = 0; i < 20; i++) h.push(tone(FRAME));
    await flush();
    const total = link.sent.reduce((a, p) => a + p.length, 0);
    expect(b.stats.callFramesIn).toBe(20);
    expect(Math.abs(total - (20 * FRAME) / 2)).toBeLessThanOrEqual(160); // a few ms of filter latency at most
    b.stop();
    h.finish();
  });

  it('turns model audio into exact 10 ms / 48 kHz frames for the call and carries the remainder over', async () => {
    const h = fakeHandle();
    const link = new FakeLink();
    const b = new RealtimeCallBridge(h.handle, link);
    b.start();
    link.audio!(tone(2400)); // 50 ms of 24 kHz audio
    link.audio!(tone(2400));
    await flush();
    expect(h.sent.length).toBeGreaterThanOrEqual(8);
    expect(h.sent.every((f) => f.samples.length === FRAME && f.sampleRateHz === 48000 && f.channels === 1 && f.encoding === 's16le')).toBe(true);
    expect(b.stats.callFramesOut).toBe(h.sent.length);
    b.stop();
    h.finish();
  });

  it('barge-in: drops queued model audio, flushes the call output, cancels the response; later audio flows again', async () => {
    const h = fakeHandle();
    const link = new FakeLink();
    const b = new RealtimeCallBridge(h.handle, link);
    b.start();
    link.audio!(tone(4800));
    link.speech!(); // the caller starts talking before the queued audio was sent
    await flush();
    expect(h.flushed()).toBe(1);
    expect(link.cancels).toBe(1);
    expect(b.stats.bargeIns).toBe(1);
    const sentBefore = h.sent.length;
    expect(sentBefore).toBe(0); // everything queued before the barge-in was dropped
    link.audio!(tone(2400));
    await flush();
    expect(h.sent.length).toBeGreaterThan(0);
    b.stop();
    h.finish();
  });

  it('asks the model to greet, forwards transcripts and records model errors; stop closes the link and stops sending', async () => {
    const h = fakeHandle();
    const link = new FakeLink();
    const lines: string[] = [];
    const b = new RealtimeCallBridge(h.handle, link, (l) => lines.push(l));
    b.start('Salom');
    expect(link.responses).toEqual(['Salom']);
    link.transcript!('assistant', 'Salom!');
    link.error!('invalid_value: bad field');
    expect(lines).toEqual(['assistant: Salom!', 'realtime error: invalid_value: bad field']);
    expect(b.stats.errors).toEqual(['invalid_value: bad field']);
    b.stop();
    expect(link.closed).toBe(true);
    link.audio!(tone(2400));
    await flush();
    expect(h.sent).toHaveLength(0);
    h.finish();
  });
});

class FakeSocket extends EventEmitter {
  sent: string[] = [];
  closed = false;
  send(s: string) {
    this.sent.push(s);
  }
  close() {
    this.closed = true;
  }
}
const open = (o: Partial<ConstructorParameters<typeof OpenAiRealtimeLink>[0]> = {}) => {
  const sock = new FakeSocket();
  let seenUrl = '';
  let seenHeaders: Record<string, string> = {};
  const link = new OpenAiRealtimeLink({
    apiKey: 'sk-test',
    model: 'some-model',
    instructions: 'be brief',
    socketFactory: (u, h) => {
      seenUrl = u;
      seenHeaders = h;
      return sock as never;
    },
    ...o,
  });
  return { link, sock, url: () => seenUrl, headers: () => seenHeaders };
};

describe('OpenAiRealtimeLink', () => {
  it('connects with bearer auth and the configured model (never a built-in default), sends session.update first, and flushes what was queued before open', () => {
    const { link, sock, url, headers } = open();
    link.respond('hello'); // before the socket is open
    link.sendAudio(new Uint8Array([1, 2]));
    expect(sock.sent).toEqual([]);
    sock.emit('open');
    expect(url()).toBe('wss://api.openai.com/v1/realtime?model=some-model');
    expect(headers()).toEqual({ Authorization: 'Bearer sk-test' });
    expect(JSON.parse(sock.sent[0]!).type).toBe('session.update');
    expect(JSON.parse(sock.sent[1]!)).toEqual({ type: 'response.create', response: { instructions: 'hello' } });
    expect(JSON.parse(sock.sent[2]!)).toEqual({ type: 'input_audio_buffer.append', audio: 'AQI=' });
  });

  it('builds both dialects of session.update; the sample rate and voice are parameters', () => {
    const ga = sessionUpdate({ instructions: 'x', voice: 'v1', sampleRateHz: 24000 }) as { session: Record<string, unknown> };
    expect(ga.session).toMatchObject({ type: 'realtime', audio: { input: { format: { type: 'audio/pcm', rate: 24000 } }, output: { voice: 'v1' } } });
    const beta = sessionUpdate({ instructions: 'x', dialect: 'beta' }) as { session: Record<string, unknown> };
    expect(beta.session).toMatchObject({ input_audio_format: 'pcm16', output_audio_format: 'pcm16', turn_detection: { type: 'server_vad' } });
    const { headers } = open({ dialect: 'beta' });
    expect(headers()['OpenAI-Beta']).toBe('realtime=v1');
  });

  it('decodes audio deltas (both event names), speech_started, transcripts and surfaces server errors verbatim', () => {
    const { link, sock } = open();
    const audio: number[][] = [];
    const events: string[] = [];
    link.onAudio((p) => audio.push([...p]));
    link.onSpeechStarted(() => events.push('speech'));
    link.onTranscript((w, t) => events.push(`${w}:${t}`));
    link.onError((m) => events.push(`err:${m}`));
    const msg = (o: object) => sock.emit('message', Buffer.from(JSON.stringify(o)));
    msg({ type: 'response.output_audio.delta', delta: 'AQI=' });
    msg({ type: 'response.audio.delta', delta: 'AwQ=' });
    msg({ type: 'input_audio_buffer.speech_started' });
    msg({ type: 'response.output_audio_transcript.done', transcript: 'Salom' });
    msg({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Assalomu alaykum' });
    msg({ type: 'error', error: { code: 'invalid_value', message: "Unknown parameter: 'session.foo'" } });
    sock.emit('message', Buffer.from('not json'));
    expect(audio).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(events).toEqual(['speech', 'assistant:Salom', 'caller:Assalomu alaykum', "err:invalid_value: Unknown parameter: 'session.foo'"]);
  });

  it('a closing socket after close() is not reported as an error', () => {
    const { link, sock } = open();
    const errs: string[] = [];
    link.onError((m) => errs.push(m));
    link.close();
    sock.emit('close', 1000);
    expect(errs).toEqual([]);
    expect(sock.closed).toBe(true);
  });
});
