import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { CallHandle, PcmFrame } from '@tgvl/contracts';
import { RealtimeCallBridge, type RealtimeLink, type ToolCall } from '../../apps/assistant/src/modules/calls/audio/realtime-bridge.js';
import { OpenAiRealtimeLink, sessionUpdate } from '../../apps/assistant/src/infrastructure/openai/realtime.js';
import { GeminiLiveLink, geminiSetup } from '../../apps/assistant/src/infrastructure/gemini/live.js';

const FRAME = 960;
const flush = () => new Promise((r) => setTimeout(r, 5));

class FakeLink implements RealtimeLink {
  inputRateHz = 24000;
  outputRateHz = 24000;
  sent: Uint8Array[] = [];
  responses: Array<string | undefined> = [];
  interrupts: number[] = [];
  responseStart?: () => void;
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
  interrupt(playedMs: number) {
    this.interrupts.push(playedMs);
  }
  onResponseStart(cb: () => void) {
    this.responseStart = cb;
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
  toolCall?: (c: ToolCall) => void;
  results: Array<{ id: string; result: unknown; respond: boolean }> = [];
  onToolCall(cb: (c: ToolCall) => void) {
    this.toolCall = cb;
  }
  sendToolResult(c: ToolCall, result: unknown, o: { respond: boolean }) {
    this.results.push({ id: c.id, result, respond: o.respond });
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

  it('barge-in: drops queued model audio, flushes the call output, interrupts the response; later audio flows again', async () => {
    const h = fakeHandle();
    const link = new FakeLink();
    const b = new RealtimeCallBridge(h.handle, link);
    b.start();
    link.audio!(tone(4800));
    link.speech!(); // the caller starts talking before the queued audio was sent
    await flush();
    expect(h.flushed()).toBe(1);
    expect(link.interrupts).toEqual([0]); // nothing of the queued audio had been played yet
    expect(b.stats.bargeIns).toBe(1);
    const sentBefore = h.sent.length;
    expect(sentBefore).toBe(0); // everything queued before the barge-in was dropped
    link.audio!(tone(2400));
    await flush();
    expect(h.sent.length).toBeGreaterThan(0);
    b.stop();
    h.finish();
  });

  it('reports how much of the response was actually played when the caller barges in', async () => {
    const h = fakeHandle();
    const link = new FakeLink();
    const b = new RealtimeCallBridge(h.handle, link);
    b.start();
    link.responseStart!();
    link.audio!(tone(4800)); // 100 ms of 24 kHz audio -> 10 frames of 10 ms
    await flush();
    expect(h.sent.length).toBeGreaterThanOrEqual(8);
    const played = h.sent.length * 10;
    link.speech!();
    expect(link.interrupts).toEqual([played]);
    link.speech!(); // a second barge-in with nothing played since
    expect(link.interrupts).toEqual([played, 0]);
    b.stop();
    h.finish();
  });

  it('asks the model to greet, forwards transcripts and records model errors; stop closes the link and stops sending', async () => {
    const h = fakeHandle();
    const link = new FakeLink();
    const lines: string[] = [];
    const b = new RealtimeCallBridge(h.handle, link, { log: (l) => lines.push(l) });
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

  it('interrupt cancels only a response that is in flight and truncates the item to what was played', () => {
    const { link, sock } = open();
    sock.emit('open');
    const msg = (o: object) => sock.emit('message', Buffer.from(JSON.stringify(o)));
    const types = () => sock.sent.map((x) => JSON.parse(x).type as string);
    link.interrupt(300); // nothing in flight, nothing said: nothing to send
    expect(types()).toEqual(['session.update']);
    msg({ type: 'response.created' });
    msg({ type: 'response.output_audio.delta', delta: 'AQI=', item_id: 'item_1' });
    link.interrupt(1234);
    expect(types().slice(1)).toEqual(['response.cancel', 'conversation.item.truncate']);
    expect(JSON.parse(sock.sent.at(-1)!)).toEqual({ type: 'conversation.item.truncate', item_id: 'item_1', content_index: 0, audio_end_ms: 1234 });
    msg({ type: 'response.done' });
    link.interrupt(10); // already truncated and finished
    expect(sock.sent).toHaveLength(3);
  });

  it('a lost cancel race is not reported as an error, but other server errors still are', () => {
    const { link, sock } = open();
    const errs: string[] = [];
    link.onError((m) => errs.push(m));
    const msg = (o: object) => sock.emit('message', Buffer.from(JSON.stringify(o)));
    msg({ type: 'error', error: { code: 'response_cancel_not_active', message: 'Cancellation failed: no active response found' } });
    msg({ type: 'error', error: { code: 'invalid_value', message: 'bad' } });
    expect(errs).toEqual(['invalid_value: bad']);
  });

  it('the input-transcription model is only sent when configured (never defaulted)', () => {
    const none = sessionUpdate({ instructions: 'x' }) as { session: { audio: { input: Record<string, unknown> } } };
    expect(none.session.audio.input).not.toHaveProperty('transcription');
    const some = sessionUpdate({ instructions: 'x', transcriptionModel: 'tm' }) as { session: { audio: { input: Record<string, unknown> } } };
    expect(some.session.audio.input.transcription).toEqual({ model: 'tm' });
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

describe('RealtimeCallBridge with different input and output rates', () => {
  it('resamples 48k -> 16k for the model and 24k -> 48k back (Gemini-style rates)', async () => {
    const h = fakeHandle();
    const link = new FakeLink();
    link.inputRateHz = 16000;
    link.outputRateHz = 24000;
    const b = new RealtimeCallBridge(h.handle, link);
    b.start();
    for (let i = 0; i < 30; i++) h.push(tone(FRAME));
    await flush();
    const total = link.sent.reduce((a, p) => a + p.length, 0);
    expect(Math.abs(total - (30 * FRAME) / 3)).toBeLessThanOrEqual(200); // 48k -> 16k is a third of the bytes
    link.audio!(tone(4800)); // 100 ms at 24 kHz
    await flush();
    expect(h.sent.length).toBeGreaterThanOrEqual(8); // 24k -> 48k doubles it: ~10 frames of 10 ms out
    b.stop();
    h.finish();
  });
});

const openGemini = (o: Partial<ConstructorParameters<typeof GeminiLiveLink>[0]> = {}) => {
  const sock = new FakeSocket();
  let seenUrl = '';
  const link = new GeminiLiveLink({
    apiKey: 'KEY123',
    model: 'some-live-model',
    instructions: 'be brief',
    socketFactory: (u) => {
      seenUrl = u;
      return sock as never;
    },
    ...o,
  });
  const msg = (x: object) => sock.emit('message', Buffer.from(JSON.stringify(x)));
  return { link, sock, msg, url: () => seenUrl };
};

describe('GeminiLiveLink', () => {
  it('sends setup first (model prefixed, audio out, instructions, transcription), and holds audio and text until setupComplete', () => {
    const { link, sock, msg, url } = openGemini({ voice: 'v1' });
    link.respond('say hi');
    link.sendAudio(new Uint8Array([1, 2]));
    sock.emit('open');
    expect(url()).toContain('?key=KEY123');
    const setup = JSON.parse(sock.sent[0]!);
    expect(setup.setup).toMatchObject({
      model: 'models/some-live-model',
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'v1' } } } },
      systemInstruction: { parts: [{ text: 'be brief' }] },
    });
    expect(setup.setup.inputAudioTranscription).toEqual({});
    expect(sock.sent).toHaveLength(1); // nothing else before setupComplete
    msg({ setupComplete: {} });
    expect(JSON.parse(sock.sent[1]!)).toEqual({ realtimeInput: { text: 'say hi' } });
    expect(JSON.parse(sock.sent[2]!)).toEqual({ realtimeInput: { audio: { data: 'AQI=', mimeType: 'audio/pcm;rate=16000' } } });
  });

  it('adds the Google Search tool and a language hint only when configured', () => {
    const plain = geminiSetup({ model: 'm', instructions: 'i' }) as { setup: Record<string, unknown> };
    expect(plain.setup).not.toHaveProperty('tools');
    expect(plain.setup.generationConfig).not.toHaveProperty('speechConfig');
    const full = geminiSetup({ model: 'm', instructions: 'i', voice: 'v', googleSearch: true, languageCode: 'uz-UZ' }) as {
      setup: { tools: unknown; generationConfig: { speechConfig: unknown } };
    };
    expect(full.setup.tools).toEqual([{ googleSearch: {} }]);
    expect(full.setup.generationConfig.speechConfig).toEqual({ voiceConfig: { prebuiltVoiceConfig: { voiceName: 'v' } }, languageCode: 'uz-UZ' });
  });

  it('never double-prefixes the model and can send the greeting as a clientContent turn for older models', () => {
    expect((geminiSetup({ model: 'models/x', instructions: 'i' }) as { setup: { model: string } }).setup.model).toBe('models/x');
    const { link, sock, msg } = openGemini({ textMode: 'client_content' });
    sock.emit('open');
    msg({ setupComplete: {} });
    link.respond('hi');
    expect(JSON.parse(sock.sent.at(-1)!)).toEqual({ clientContent: { turns: [{ role: 'user', parts: [{ text: 'hi' }] }], turnComplete: true } });
  });

  it('decodes audio parts, reports response start once per turn, barge-in via interrupted, and groups transcripts per turn', () => {
    const { link, sock, msg } = openGemini();
    sock.emit('open');
    msg({ setupComplete: {} });
    const events: string[] = [];
    const audio: number[][] = [];
    link.onAudio((p) => audio.push([...p]));
    link.onResponseStart(() => events.push('start'));
    link.onSpeechStarted(() => events.push('interrupted'));
    link.onTranscript((w, t) => events.push(`${w}:${t}`));
    msg({ serverContent: { inputTranscription: { text: 'Salom ' } } });
    msg({
      serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AQI=' } }] }, outputTranscription: { text: 'Assalomu ' } },
    });
    msg({
      serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AwQ=' } }] }, outputTranscription: { text: 'alaykum' } },
    });
    msg({ serverContent: { turnComplete: true } });
    msg({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'BQ==' } }] } } });
    msg({ serverContent: { interrupted: true } });
    expect(audio).toEqual([[1, 2], [3, 4], [5]]);
    expect(events).toEqual(['start', 'caller:Salom', 'assistant:Assalomu alaykum', 'start', 'interrupted']);
  });

  it('refuses audio in an unexpected format instead of playing garbage, and surfaces server errors and unexpected closes verbatim (key redacted)', () => {
    const { link, sock, msg } = openGemini();
    const errs: string[] = [];
    link.onError((m) => errs.push(m));
    const audio: number[][] = [];
    link.onAudio((p) => audio.push([...p]));
    sock.emit('open');
    msg({ setupComplete: {} });
    msg({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=16000', data: 'AQI=' } }] } } });
    msg({ error: { code: 400, message: 'bad request' } });
    sock.emit('close', 1007, Buffer.from('Invalid value at setup (KEY123)'));
    expect(audio).toEqual([]);
    expect(errs).toEqual([
      'unexpected audio format audio/pcm;rate=16000 (expected 24000 Hz PCM)',
      '400: bad request',
      'websocket closed (1007) Invalid value at setup (***)',
    ]);
  });

  it('a close we initiated is not an error', () => {
    const { link, sock } = openGemini();
    const errs: string[] = [];
    link.onError((m) => errs.push(m));
    link.close();
    sock.emit('close', 1000, Buffer.from(''));
    expect(errs).toEqual([]);
  });
});

describe('silent-model diagnostics', () => {
  it('RealtimeCallBridge reports a model that never speaks after the greeting request', async () => {
    const h = fakeHandle();
    const link = new FakeLink();
    const lines: string[] = [];
    const b = new RealtimeCallBridge(h.handle, link, { log: (l) => lines.push(l), silenceMs: 30 });
    b.start('hi');
    await new Promise((r) => setTimeout(r, 60));
    expect(b.stats.errors).toEqual(['the model produced no audio 0.03 s after the greeting request']);
    b.stop();
    h.finish();
  });
  it('...but not when audio did arrive, and stop() cancels the watchdog', async () => {
    const h = fakeHandle();
    const link = new FakeLink();
    const b = new RealtimeCallBridge(h.handle, link, { silenceMs: 30 });
    b.start('hi');
    link.audio!(tone(2400));
    await new Promise((r) => setTimeout(r, 60));
    expect(b.stats.errors).toEqual([]);
    const b2 = new RealtimeCallBridge(fakeHandle().handle, new FakeLink(), { silenceMs: 30 });
    b2.start('hi');
    b2.stop();
    await new Promise((r) => setTimeout(r, 60));
    expect(b2.stats.errors).toEqual([]);
    b.stop();
    h.finish();
  });
  it('GeminiLiveLink reports a setup that never completes, and describes messages without leaking data', async () => {
    const sock = new FakeSocket();
    const lines: string[] = [];
    const link = new GeminiLiveLink({
      apiKey: 'K',
      model: 'm',
      instructions: 'i',
      setupTimeoutMs: 20,
      debug: (l) => lines.push(l),
      socketFactory: () => sock as never,
    });
    const errs: string[] = [];
    link.onError((m) => errs.push(m));
    sock.emit('open');
    await new Promise((r) => setTimeout(r, 50));
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/no setupComplete within 0\.02 s/);
    sock.emit(
      'message',
      Buffer.from(
        JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AQI=' } }] }, turnComplete: true } }),
      ),
    );
    expect(lines).toContain('serverContent audioParts=1 turnComplete');
    expect(lines.join('\n')).not.toContain('AQI=');
    link.close();
  });
});

describe('tools', () => {
  it('runs the tool, returns its result to the model, and performs the after-playout action only after the output drained', async () => {
    const h = fakeHandle();
    let drainedCalls = 0;
    let release!: () => void;
    (h.handle as { drained?: () => Promise<void> }).drained = () => {
      drainedCalls++;
      return new Promise<void>((r) => (release = r));
    };
    const link = new FakeLink();
    const order: string[] = [];
    const b = new RealtimeCallBridge(h.handle, link, {
      playoutGraceMs: 1,
      onTool: (call) => {
        order.push(`tool:${call.name}`);
        return { result: { ok: true }, respond: false, afterPlayout: () => void order.push('hangup') };
      },
    });
    b.start();
    link.audio!(tone(2400)); // the farewell the model already spoke
    link.toolCall!({ id: 'c1', name: 'end_call', args: { reason: 'bye' } });
    await flush();
    expect(link.results).toEqual([{ id: 'c1', result: { ok: true }, respond: false }]);
    expect(order).toEqual(['tool:end_call']); // not hung up while audio is still playing
    expect(drainedCalls).toBe(1);
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(['tool:end_call', 'hangup']);
    b.stop();
    h.finish();
  });

  it('the caller speaking after the end was requested cancels the hang-up (the conversation is not over)', async () => {
    const h = fakeHandle();
    let release!: () => void;
    (h.handle as { drained?: () => Promise<void> }).drained = () => new Promise<void>((r) => (release = r));
    const link = new FakeLink();
    const lines: string[] = [];
    let hungUp = 0;
    const b = new RealtimeCallBridge(h.handle, link, {
      log: (l) => lines.push(l),
      playoutGraceMs: 1,
      onTool: () => ({ result: { ok: true }, respond: false, afterPlayout: () => void hungUp++ }),
    });
    b.start();
    link.toolCall!({ id: 'c1', name: 'end_call', args: {} });
    await flush();
    link.speech!(); // the caller says something before the farewell finished playing
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(hungUp).toBe(0);
    expect(lines.some((l) => l.includes('hang-up cancelled'))).toBe(true);
    // a later, uninterrupted end request still works
    link.toolCall!({ id: 'c2', name: 'end_call', args: {} });
    await flush();
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(hungUp).toBe(1);
    b.stop();
    h.finish();
  });

  it('a tool that throws, or an unknown tool, tells the model it failed (never a made-up success)', async () => {
    const h = fakeHandle();
    const link = new FakeLink();
    const b = new RealtimeCallBridge(h.handle, link, {
      onTool: () => {
        throw new Error('db down');
      },
    });
    b.start();
    link.toolCall!({ id: 'c1', name: 'x', args: {} });
    await flush();
    expect(link.results).toEqual([{ id: 'c1', result: { error: 'db down' }, respond: true }]);
    b.stop();
    const h2 = fakeHandle();
    const link2 = new FakeLink();
    const b2 = new RealtimeCallBridge(h2.handle, link2);
    b2.start();
    link2.toolCall!({ id: 'c2', name: 'nope', args: {} });
    await flush();
    expect(link2.results[0]).toEqual({ id: 'c2', result: { error: 'unknown tool nope' }, respond: true });
    b2.stop();
    h.finish();
    h2.finish();
  });

  it('OpenAI: declares tools in session.update, parses function_call items, answers with function_call_output (+ response.create only when asked)', () => {
    const tools = [{ name: 'end_call', description: 'd', parameters: { type: 'object', properties: {} } }];
    const ga = sessionUpdate({ instructions: 'x', tools }) as { session: Record<string, unknown> };
    expect(ga.session.tools).toEqual([{ type: 'function', name: 'end_call', description: 'd', parameters: { type: 'object', properties: {} } }]);
    expect(ga.session.tool_choice).toBe('auto');
    expect(sessionUpdate({ instructions: 'x' }) as object).not.toHaveProperty('session.tools');

    const { link, sock } = open({ tools });
    sock.emit('open');
    const calls: unknown[] = [];
    link.onToolCall((c) => calls.push(c));
    sock.emit(
      'message',
      Buffer.from(
        JSON.stringify({ type: 'response.output_item.done', item: { type: 'function_call', name: 'end_call', call_id: 'cid', arguments: '{"reason":"bye"}' } }),
      ),
    );
    sock.emit('message', Buffer.from(JSON.stringify({ type: 'response.output_item.done', item: { type: 'message' } })));
    expect(calls).toEqual([{ id: 'cid', name: 'end_call', args: { reason: 'bye' } }]);
    link.sendToolResult({ id: 'cid', name: 'end_call', args: {} }, { ok: true }, { respond: false });
    expect(sock.sent.map((x) => JSON.parse(x).type)).toEqual(['session.update', 'conversation.item.create']);
    expect(JSON.parse(sock.sent.at(-1)!).item).toEqual({ type: 'function_call_output', call_id: 'cid', output: '{"ok":true}' });
    link.sendToolResult({ id: 'cid2', name: 'x', args: {} }, 1, { respond: true });
    expect(sock.sent.map((x) => JSON.parse(x).type).slice(-2)).toEqual(['conversation.item.create', 'response.create']);
  });

  it('Gemini: function declarations next to googleSearch, toolCall parsed, toolResponse shaped as the API expects', () => {
    const tools = [{ name: 'end_call', description: 'd', parameters: { type: 'object', properties: {} } }];
    const setup = geminiSetup({ model: 'm', instructions: 'i', googleSearch: true, tools }) as { setup: { tools: unknown } };
    expect(setup.setup.tools).toEqual([
      { googleSearch: {} },
      { functionDeclarations: [{ name: 'end_call', description: 'd', parameters: { type: 'object', properties: {} } }] },
    ]);
    const { link, sock, msg } = openGemini({ tools });
    sock.emit('open');
    msg({ setupComplete: {} });
    const calls: unknown[] = [];
    link.onToolCall((c) => calls.push(c));
    msg({ toolCall: { functionCalls: [{ id: 'f1', name: 'end_call', args: { reason: 'bye' } }] } });
    expect(calls).toEqual([{ id: 'f1', name: 'end_call', args: { reason: 'bye' } }]);
    link.sendToolResult({ id: 'f1', name: 'end_call', args: {} }, { ok: true });
    expect(JSON.parse(sock.sent.at(-1)!)).toEqual({
      toolResponse: { functionResponses: [{ id: 'f1', name: 'end_call', response: { output: { ok: true } } }] },
    });
  });
});

describe('inbound audio evidence', () => {
  it('counts non-silent incoming frames separately from silence', async () => {
    const h = fakeHandle();
    const link = new FakeLink();
    const b = new RealtimeCallBridge(h.handle, link);
    b.start();
    for (let i = 0; i < 5; i++) h.push(new Uint8Array(FRAME)); // digital silence
    for (let i = 0; i < 3; i++) h.push(tone(FRAME, 8000)); // real signal
    await flush();
    expect(b.stats.callFramesIn).toBe(8);
    expect(b.stats.nonSilentFramesIn).toBe(3);
    b.stop();
    h.finish();
  });
});
