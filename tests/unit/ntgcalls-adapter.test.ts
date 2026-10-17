import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DialOutcomeUnknownError, DialRejectedError, type ApprovedCallPlan, type CallEvent } from '@tgvl/contracts';
import { NtgcallsCallAdapter, mapDiscard } from '../../apps/assistant/src/modules/calls/ntgcalls/adapter.js';
import type { TransportUpdate } from '../../apps/assistant/src/modules/calls/ntgcalls/guards.js';
import type { CallTransport, ConfirmedCall, MediaSession, MediaState } from '../../apps/assistant/src/modules/calls/ntgcalls/ports.js';

const SELF = '8829917892';
const PEER = '370898987';
const REF = { id: '777', accessHash: '999' };
const FRAME = 960;

class FakeTransport implements CallTransport {
  selfId = SELF;
  log: string[] = [];
  listeners = new Set<(u: TransportUpdate) => void>();
  requestMode: 'ok' | 'reject' | 'network' | 'hang' = 'ok';
  rejectMessage = 'USER_PRIVACY_RESTRICTED';
  discardFails = false;
  discards: Array<{ kind: string; durationSeconds: number }> = [];
  signalingSent: Uint8Array[] = [];
  lateResolve: (() => void) | null = null;
  async getDhConfig() {
    this.log.push('dh');
    return { g: 3, p: new Uint8Array(4), random: new Uint8Array(4) };
  }
  async requestCall() {
    this.log.push('request');
    if (this.requestMode === 'reject') throw Object.assign(new Error('rpc'), { errorMessage: this.rejectMessage });
    if (this.requestMode === 'network') throw new Error('socket closed');
    if (this.requestMode === 'hang')
      return new Promise<{ ref: typeof REF; adminId: string; participantId: string }>((res) => {
        this.lateResolve = () => res({ ref: REF, adminId: SELF, participantId: PEER });
      });
    return { ref: REF, adminId: SELF, participantId: PEER };
  }
  async confirmCall(): Promise<ConfirmedCall> {
    this.log.push('confirm');
    return { servers: [], versions: ['8.0.0'], p2pAllowed: false, customParameters: '{}' };
  }
  async discardCall(_r: unknown, a: { durationSeconds: number; kind: string }) {
    this.log.push('discard');
    if (this.discardFails) throw new Error('network down');
    this.discards.push(a);
  }
  async sendSignaling(_r: unknown, d: Uint8Array) {
    this.signalingSent.push(d);
  }
  subscribe(l: (u: TransportUpdate) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(u: TransportUpdate) {
    for (const l of [...this.listeners]) l(u);
  }
}

class FakeMedia implements MediaSession {
  log: string[] = [];
  sent: Uint8Array[] = [];
  stopped = false;
  #state?: (s: MediaState) => void;
  #frame?: (b: Uint8Array) => void;
  #sig?: (d: Uint8Array) => void;
  async prepare() {
    this.log.push('prepare');
    return new Uint8Array([1, 2, 3]);
  }
  async exchangeKeys() {
    this.log.push('exchangeKeys');
    return { gA: new Uint8Array([9]), keyFingerprint: 5n };
  }
  async connect() {
    this.log.push('connect');
  }
  async attachPlayback() {
    this.log.push('attachPlayback');
  }
  async receiveSignaling() {
    this.log.push('signaling-in');
  }
  onSignaling(cb: (d: Uint8Array) => void) {
    this.#sig = cb;
  }
  onState(cb: (s: MediaState) => void) {
    this.#state = cb;
  }
  onFrame(cb: (b: Uint8Array) => void) {
    this.#frame = cb;
  }
  async sendFrame(b: Uint8Array) {
    this.sent.push(b);
  }
  async stop() {
    this.stopped = true;
  }
  setState(s: MediaState) {
    this.#state?.(s);
  }
  inbound(b: Uint8Array) {
    this.#frame?.(b);
  }
  outSignal(d: Uint8Array) {
    this.#sig?.(d);
  }
}

const plan = (): ApprovedCallPlan => ({
  callRequestId: '11111111-1111-4111-8111-111111111111',
  ownerId: '22222222-2222-4222-8222-222222222222',
  recipientTelegramId: PEER,
  topic: 'self_test',
  purpose: 'adapter test',
  questions: [],
  allowedContext: [],
  forbiddenCommitments: [],
  language: 'uz',
  maxDurationSeconds: 60,
  authorizationId: '33333333-3333-4333-8333-333333333333',
  permissionVersion: 0,
  planHash: 'a'.repeat(64),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});

const flush = () => new Promise((r) => setImmediate(r));

function setup() {
  const transport = new FakeTransport();
  const media = new FakeMedia();
  const tick: { fn: (() => void) | null; stopped: boolean } = { fn: null, stopped: false };
  const adapter = new NtgcallsCallAdapter({
    transport,
    media: () => media,
    buildFingerprint: 'test',
    heartbeatMs: 15_000,
    startTicker: (fn) => {
      tick.fn = fn;
      return { stop: () => (tick.stopped = true) };
    },
  });
  return { transport, media, adapter, tick };
}

async function connectedCall(s: ReturnType<typeof setup>) {
  const handle = await s.adapter.dial(plan(), new AbortController().signal);
  s.transport.emit({ kind: 'waiting', id: REF.id, delivered: true, adminId: SELF, participantId: PEER });
  s.transport.emit({ kind: 'accepted', id: REF.id, gB: new Uint8Array([7]), adminId: SELF, participantId: PEER });
  await flush();
  s.media.setState('connected');
  await flush();
  return handle;
}

async function nextEvents(handle: { events: AsyncIterable<CallEvent> }, n: number) {
  const out: CallEvent[] = [];
  const it = handle.events[Symbol.asyncIterator]();
  while (out.length < n) {
    const r = await it.next();
    if (r.done) break;
    out.push(r.value);
  }
  return out;
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }));
afterEach(() => vi.useRealTimers());

describe('NtgcallsCallAdapter', () => {
  it('runs the verified handshake order and reports ringing -> connected', async () => {
    const s = setup();
    const handle = await connectedCall(s);
    expect(s.transport.log).toEqual(['dh', 'request', 'confirm']);
    expect(s.media.log).toEqual(['prepare', 'exchangeKeys', 'connect', 'attachPlayback']);
    const evs = await nextEvents(handle, 3);
    expect(evs.map((e) => e.type)).toEqual(['heartbeat', 'ringing', 'connected']);
    expect(evs.every((e) => e.providerCallId === REF.id)).toBe(true);
  });

  it('keeps the outbound stream continuous with 10 ms silence and sends queued speech frame-exact', async () => {
    const s = setup();
    const handle = await connectedCall(s);
    s.tick.fn!();
    expect(s.media.sent.at(-1)!.length).toBe(FRAME);
    expect([...s.media.sent.at(-1)!].every((b) => b === 0)).toBe(true);
    const speech = new Uint8Array(FRAME * 2).map((_, i) => (i % 250) + 1);
    await handle.sendAudio({
      callId: handle.callId,
      sequence: 0,
      monotonicTimestampUs: 0,
      sampleRateHz: 48000,
      channels: 1,
      encoding: 's16le',
      samples: speech,
    });
    s.tick.fn!();
    s.tick.fn!();
    s.tick.fn!();
    expect(s.media.sent.at(-3)).toEqual(speech.subarray(0, FRAME));
    expect(s.media.sent.at(-2)).toEqual(speech.subarray(FRAME));
    expect([...s.media.sent.at(-1)!].every((b) => b === 0)).toBe(true); // back to silence
  });

  it('drained() resolves only once everything queued has been played out', async () => {
    const s = setup();
    const handle = await connectedCall(s);
    const speech = new Uint8Array(FRAME * 3).fill(7);
    await handle.sendAudio({
      callId: handle.callId,
      sequence: 0,
      monotonicTimestampUs: 0,
      sampleRateHz: 48000,
      channels: 1,
      encoding: 's16le',
      samples: speech,
    });
    let done = false;
    void handle.drained!().then(() => (done = true));
    await new Promise((r) => setTimeout(r, 60));
    expect(done).toBe(false); // nothing has been played yet
    s.tick.fn!();
    s.tick.fn!();
    s.tick.fn!();
    await new Promise((r) => setTimeout(r, 60));
    expect(done).toBe(true);
  });

  it('rejects audio that is not 48 kHz mono s16le in 10 ms multiples', async () => {
    const s = setup();
    const handle = await connectedCall(s);
    const base = { callId: handle.callId, sequence: 0, monotonicTimestampUs: 0, channels: 1 as const, encoding: 's16le' as const };
    await expect(handle.sendAudio({ ...base, sampleRateHz: 24000, samples: new Uint8Array(FRAME) })).rejects.toThrow(/48 kHz/);
    await expect(handle.sendAudio({ ...base, sampleRateHz: 48000, samples: new Uint8Array(FRAME + 2) })).rejects.toThrow(/10 ms/);
  });

  it('delivers inbound frames as PcmFrames', async () => {
    const s = setup();
    const handle = await connectedCall(s);
    s.media.inbound(new Uint8Array(FRAME).fill(3));
    const it = handle.incomingAudio[Symbol.asyncIterator]();
    const f = (await it.next()).value!;
    expect(f).toMatchObject({ sequence: 0, sampleRateHz: 48000, channels: 1, encoding: 's16le', callId: handle.callId });
    expect(f.samples.length).toBe(FRAME);
  });

  it('maps a remote hangup after connect to completed and shuts everything down', async () => {
    const s = setup();
    const handle = await connectedCall(s);
    s.transport.emit({ kind: 'discarded', id: REF.id, reason: 'PhoneCallDiscardReasonHangup', adminId: SELF, participantId: PEER });
    await flush();
    const evs = await nextEvents(handle, 10);
    expect(evs.at(-1)).toMatchObject({ type: 'ended', reason: 'completed' });
    expect(s.media.stopped).toBe(true);
    expect(s.tick.stopped).toBe(true);
    expect(await s.adapter.reconcile(REF.id)).toBe('ended');
  });

  it('classifies discards honestly (F-12: Disconnect before accept is how a rejected ring looked)', () => {
    expect(mapDiscard('PhoneCallDiscardReasonDisconnect', false)).toBe('no_answer');
    expect(mapDiscard('PhoneCallDiscardReasonDisconnect', true)).toBe('transport_error');
    expect(mapDiscard('PhoneCallDiscardReasonHangup', false)).toBe('declined');
    expect(mapDiscard('PhoneCallDiscardReasonHangup', true)).toBe('completed');
    expect(mapDiscard('PhoneCallDiscardReasonBusy', false)).toBe('busy');
    expect(mapDiscard('PhoneCallDiscardReasonMissed', false)).toBe('no_answer');
    expect(mapDiscard('SomethingNew', false)).toBe('transport_error');
  });

  it('a server rejection is definite: privacy_restricted, nothing placed, no discard, media released', async () => {
    const s = setup();
    s.transport.requestMode = 'reject';
    await expect(s.adapter.dial(plan(), new AbortController().signal)).rejects.toMatchObject({ reason: 'privacy_restricted' });
    expect(s.transport.log).not.toContain('discard');
    expect(s.media.stopped).toBe(true);
    expect(s.transport.listeners.size).toBe(0);
    // the adapter is free again
    s.transport.requestMode = 'ok';
    s.media.stopped = false;
    await expect(s.adapter.dial(plan(), new AbortController().signal)).resolves.toBeDefined();
  });

  it('FLOOD_WAIT carries retryAfter', async () => {
    const s = setup();
    s.transport.requestMode = 'reject';
    s.transport.rejectMessage = 'FLOOD_WAIT_42';
    const err = await s.adapter.dial(plan(), new AbortController().signal).catch((e) => e);
    expect(err).toBeInstanceOf(DialRejectedError);
    expect(err.retryAfterSeconds).toBe(42);
  });

  it('a failure without a server answer is an UNKNOWN outcome, never a rejection', async () => {
    const s = setup();
    s.transport.requestMode = 'network';
    await expect(s.adapter.dial(plan(), new AbortController().signal)).rejects.toBeInstanceOf(DialOutcomeUnknownError);
  });

  it('abort after submit is unknown, and a late-landing call is hung up at once', async () => {
    const s = setup();
    s.transport.requestMode = 'hang';
    const ac = new AbortController();
    const p = s.adapter.dial(plan(), ac.signal);
    await flush();
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(DialOutcomeUnknownError);
    s.transport.lateResolve!();
    await flush();
    await flush();
    expect(s.transport.discards).toHaveLength(1);
    expect(s.media.stopped).toBe(true);
  });

  it('abort before submit is a definite cancel and nothing is requested', async () => {
    const s = setup();
    const ac = new AbortController();
    ac.abort();
    await expect(s.adapter.dial(plan(), ac.signal)).rejects.toMatchObject({ reason: 'cancelled' });
    expect(s.transport.log).toEqual([]);
  });

  it('ignores updates for any other call and does not let them become the cleanup target', async () => {
    const s = setup();
    const handle = await s.adapter.dial(plan(), new AbortController().signal);
    s.transport.emit({ kind: 'discarded', id: '555', reason: 'PhoneCallDiscardReasonHangup' });
    s.transport.emit({ kind: 'accepted', id: REF.id, gB: new Uint8Array([7]), adminId: '1', participantId: PEER }); // wrong admin
    await flush();
    expect(s.media.log).toEqual(['prepare']);
    expect(s.media.stopped).toBe(false);
    await handle.end('cancelled');
    expect(s.transport.discards).toHaveLength(1);
  });

  it('replays early updates that belong to our call and drops the rest', async () => {
    const s = setup();
    s.transport.requestCall = async () => {
      s.transport.emit({ kind: 'waiting', id: REF.id, delivered: true });
      s.transport.emit({ kind: 'discarded', id: 'other', reason: 'PhoneCallDiscardReasonBusy' });
      return { ref: REF, adminId: SELF, participantId: PEER };
    };
    const handle = await s.adapter.dial(plan(), new AbortController().signal);
    const evs = await nextEvents(handle, 2);
    expect(evs.map((e) => e.type)).toEqual(['heartbeat', 'ringing']);
  });

  it('end(): the end is only reported after the server accepted the hangup; a failed hangup stays unproven and can be retried', async () => {
    const s = setup();
    const handle = await connectedCall(s);
    s.transport.discardFails = true;
    await expect(handle.end('duration_limit')).rejects.toThrow();
    expect(await s.adapter.reconcile(REF.id)).toBe('active');
    expect(s.media.stopped).toBe(false);
    s.transport.discardFails = false;
    await handle.end('duration_limit');
    expect(s.transport.discards).toHaveLength(1);
    expect(await s.adapter.reconcile(REF.id)).toBe('ended');
    const evs = await nextEvents(handle, 10);
    expect(evs.at(-1)).toMatchObject({ type: 'ended', reason: 'duration_limit' });
  });

  it('uses the right discard kind for an unanswered ring and reports the connected duration', async () => {
    const s = setup();
    const handle = await s.adapter.dial(plan(), new AbortController().signal);
    await handle.end('no_answer');
    expect(s.transport.discards[0]).toEqual({ kind: 'missed', durationSeconds: 0 });
  });

  it('a media failure hangs the call up instead of leaving it open', async () => {
    const s = setup();
    const handle = await connectedCall(s);
    s.media.setState('failed');
    await flush();
    await flush();
    expect(s.transport.discards).toHaveLength(1);
    const evs = await nextEvents(handle, 10);
    expect(evs.at(-1)).toMatchObject({ type: 'ended', reason: 'transport_error' });
  });

  it('emits a heartbeat at least every 30 s while live', async () => {
    const s = setup();
    const handle = await s.adapter.dial(plan(), new AbortController().signal);
    vi.advanceTimersByTime(31_000);
    const evs = await nextEvents(handle, 3);
    expect(evs.filter((e) => e.type === 'heartbeat').length).toBeGreaterThanOrEqual(3); // initial + two intervals of 15 s
    await handle.end('cancelled');
  });

  it('refuses a second concurrent call and answers unknown for calls it has no memory of', async () => {
    const s = setup();
    await s.adapter.dial(plan(), new AbortController().signal);
    await expect(s.adapter.dial(plan(), new AbortController().signal)).rejects.toBeInstanceOf(DialRejectedError);
    expect(await s.adapter.reconcile('unheard-of')).toBe('unknown');
  });

  it('relays media signaling to Telegram and Telegram signaling to media', async () => {
    const s = setup();
    await s.adapter.dial(plan(), new AbortController().signal);
    s.media.outSignal(new Uint8Array([4, 5]));
    s.transport.emit({ kind: 'signaling', id: REF.id, data: new Uint8Array([6]) });
    await flush();
    expect(s.transport.signalingSent).toEqual([new Uint8Array([4, 5])]);
    expect(s.media.log).toContain('signaling-in');
  });
});
