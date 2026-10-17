import {
  DialOutcomeUnknownError,
  DialRejectedError,
  type ApprovedCallPlan,
  type CallAdapterCapabilities,
  type CallEndReason,
  type CallEvent,
  type CallHandle,
  type PcmFrame,
  type ReconcileResult,
  type TelegramCallAdapter,
} from '@tgvl/contracts';
import { AsyncQueue } from './async-queue.js';
import { CallUpdateGate, PlacementTracker, serverErrorMessage, type CallRef, type TransportUpdate } from './guards.js';
import type { CallTransport, DiscardKind, MediaSession, MediaSessionFactory } from './ports.js';

/** 48 kHz mono s16le; ntgcalls external audio must be an integer multiple of 10 ms (20 ms frames were distorted in the first live run). */
const SAMPLE_RATE = 48_000;
const FRAME_BYTES = (SAMPLE_RATE / 100) * 2; // 10 ms = 480 samples = 960 bytes

export interface Ticker {
  stop(): void;
}
export type StartTicker = (tick: () => void, intervalMs: number) => Ticker;

/** Drift-corrected ticker: ticks stay on a monotonic schedule instead of accumulating setTimeout error. */
export const driftCorrectedTicker: StartTicker = (tick, intervalMs) => {
  let stopped = false;
  let n = 0;
  const start = performance.now();
  let timer: NodeJS.Timeout | undefined;
  const loop = () => {
    if (stopped) return;
    tick();
    n++;
    timer = setTimeout(loop, Math.max(0, start + n * intervalMs - performance.now()));
  };
  timer = setTimeout(loop, intervalMs);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
};

export interface NtgcallsAdapterOptions {
  transport: CallTransport;
  media: MediaSessionFactory;
  buildFingerprint: string;
  /** Contract: a heartbeat at least every 30 s while a call is live. */
  heartbeatMs?: number;
  /** Outbound audio buffered beyond this is back-pressured, not dropped. */
  maxOutboundMs?: number;
  startTicker?: StartTicker;
  now?: () => Date;
  randomId?: () => number;
}

/** Maps Telegram's discard class to our end reason. Before the callee accepted, `Disconnect` is what a rejected ring looked like live (F-12). */
export function mapDiscard(reasonClass: string, connected: boolean): CallEndReason {
  if (reasonClass === 'PhoneCallDiscardReasonBusy') return 'busy';
  if (reasonClass === 'PhoneCallDiscardReasonMissed') return connected ? 'completed' : 'no_answer';
  if (reasonClass === 'PhoneCallDiscardReasonHangup') return connected ? 'completed' : 'declined';
  if (reasonClass === 'PhoneCallDiscardReasonDisconnect') return connected ? 'transport_error' : 'no_answer';
  return connected ? 'completed' : 'transport_error';
}

const DISCARD_KIND: Partial<Record<CallEndReason, DiscardKind>> = { no_answer: 'missed', busy: 'busy', transport_error: 'disconnect' };

export function mapRequestCallError(e: unknown): DialRejectedError | null {
  const m = serverErrorMessage(e);
  if (!m) return null;
  if (m === 'USER_PRIVACY_RESTRICTED' || m === 'USER_IS_BLOCKED') return new DialRejectedError('privacy_restricted', `telegram rejected the call: ${m}`);
  if (m === 'USER_BUSY') return new DialRejectedError('busy', `telegram rejected the call: ${m}`);
  const flood = /^FLOOD_WAIT_(\d+)$/.exec(m);
  if (flood) return new DialRejectedError('transport_error', `telegram rate limit: ${m}`, Number(flood[1]));
  return new DialRejectedError('transport_error', `telegram rejected the call: ${m}`);
}

export class NtgcallsCallAdapter implements TelegramCallAdapter {
  readonly #o: Required<Omit<NtgcallsAdapterOptions, 'transport' | 'media' | 'buildFingerprint'>> & NtgcallsAdapterOptions;
  #active: ActiveCall | null = null;
  readonly #ended = new Set<string>();

  constructor(options: NtgcallsAdapterOptions) {
    this.#o = {
      heartbeatMs: 15_000,
      maxOutboundMs: 30_000,
      startTicker: driftCorrectedTicker,
      now: () => new Date(),
      randomId: () => Math.floor(Math.random() * 0x7fffffff),
      ...options,
    };
  }

  /** The adapter's own report is never trusted for enabling calls: EvidenceGatedCallAdapter derives capabilities from the evidence artifact. */
  async capabilities(): Promise<CallAdapterCapabilities> {
    return {
      privateOutbound: true,
      privateInbound: false,
      pcmSend: true,
      pcmReceive: true,
      evidenceArtifact: null,
      buildFingerprint: this.#o.buildFingerprint,
    };
  }

  /** In-memory only: after a process restart the answer is `unknown` (never a guess), which keeps the account occupied until resolved. */
  async reconcile(providerCallId: string): Promise<ReconcileResult> {
    if (this.#active?.ref.id === providerCallId) return 'active';
    if (this.#ended.has(providerCallId)) return 'ended';
    return 'unknown';
  }

  async dial(plan: ApprovedCallPlan, signal: AbortSignal): Promise<CallHandle> {
    if (this.#active) throw new DialRejectedError('transport_error', 'the call adapter already has an active call');
    if (signal.aborted) throw new DialRejectedError('cancelled');
    const o = this.#o;
    const tracker = new PlacementTracker();
    const gate = new CallUpdateGate(o.transport.selfId, plan.recipientTelegramId);
    const media = o.media();
    const call = new ActiveCall(plan, media, tracker, o, (id) => {
      this.#ended.add(id);
      if (this.#ended.size > 200) this.#ended.delete(this.#ended.values().next().value as string);
      if (this.#active === call) this.#active = null;
    });
    this.#active = call;
    const early: TransportUpdate[] = [];
    const unsubscribe = o.transport.subscribe((u) => {
      const v = gate.classify(u);
      if (v === 'buffer') gate.buffer(u);
      else if (v === 'accept') call.onUpdate(u);
    });
    call.attachUnsubscribe(unsubscribe);
    const abortBeforeSubmit = async (): Promise<never> => {
      unsubscribe();
      await media.stop().catch(() => undefined);
      this.#active = null;
      throw new DialRejectedError('cancelled');
    };
    let gaHash: Uint8Array;
    try {
      const dh = await o.transport.getDhConfig();
      gaHash = await media.prepare(dh);
    } catch {
      unsubscribe();
      await media.stop().catch(() => undefined);
      this.#active = null;
      throw new DialRejectedError('transport_error', 'could not prepare the call (DH config / media setup)');
    }
    if (signal.aborted) return abortBeforeSubmit();

    // From the next line on a timeout cannot prove the call was not placed.
    tracker.markSubmitted();
    const request = o.transport.requestCall({ recipientTelegramId: plan.recipientTelegramId, gAHash: gaHash, randomId: o.randomId() });
    let aborted = false;
    const abortP = new Promise<never>((_, rej) =>
      signal.addEventListener(
        'abort',
        () => {
          aborted = true;
          rej(new DialOutcomeUnknownError('dial aborted after the request was submitted'));
        },
        { once: true },
      ),
    );
    abortP.catch(() => undefined); // the race below may be settled by the request first
    let placed;
    try {
      placed = await Promise.race([request, abortP]);
    } catch (e) {
      if (e instanceof DialOutcomeUnknownError && aborted) {
        // The request may still land later: if it does, hang that call up immediately; never leave a ringing call behind.
        void request.then(
          async (late) => {
            await o.transport.discardCall(late.ref, { durationSeconds: 0, kind: 'hangup' }).catch(() => undefined);
          },
          () => undefined,
        );
        unsubscribe();
        await media.stop().catch(() => undefined);
        this.#active = null;
        throw e;
      }
      tracker.markSubmitFailed(e);
      unsubscribe();
      await media.stop().catch(() => undefined);
      this.#active = null;
      const rejected = mapRequestCallError(e);
      if (rejected) throw rejected;
      throw new DialOutcomeUnknownError(`request failed without a server answer: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    }
    tracker.markConfirmed();
    for (const u of gate.bind(placed.ref)) early.push(u);
    call.start(placed.ref);
    for (const u of early) call.onUpdate(u);
    return call.handle();
  }
}

class ActiveCall {
  ref!: CallRef;
  readonly #events = new AsyncQueue<CallEvent>();
  readonly #incoming = new AsyncQueue<PcmFrame>(500);
  #outbound: Uint8Array[] = [];
  #outboundBytes = 0;
  #drainWaiters: Array<() => void> = [];
  #seq = 0;
  #eventSeq = 0;
  #connected = false;
  #ending: Promise<void> | null = null;
  #finished = false;
  #connectedAt: number | null = null;
  #pump: { stop(): void } | null = null;
  #heartbeat: NodeJS.Timeout | null = null;
  #unsubscribe: (() => void) | null = null;
  #t0 = performance.now();

  constructor(
    private readonly plan: ApprovedCallPlan,
    private readonly media: MediaSession,
    private readonly tracker: PlacementTracker,
    private readonly o: NtgcallsAdapterOptions & { heartbeatMs: number; maxOutboundMs: number; startTicker: StartTicker; now: () => Date },
    private readonly onFinished: (providerCallId: string) => void,
  ) {}

  attachUnsubscribe(u: () => void): void {
    this.#unsubscribe = u;
  }

  start(ref: CallRef): void {
    this.ref = ref;
    this.media.onSignaling((data) => {
      void this.o.transport.sendSignaling(ref, data).catch(() => undefined);
    });
    this.media.onState((s) => {
      if (s === 'connected') void this.#onMediaConnected();
      else if (s === 'failed') void this.#fail('transport_error');
    });
    this.media.onFrame((pcm) => {
      this.#incoming.push({
        callId: this.plan.callRequestId,
        sequence: this.#seq++,
        monotonicTimestampUs: Math.round((performance.now() - this.#t0) * 1000),
        sampleRateHz: SAMPLE_RATE,
        channels: 1,
        encoding: 's16le',
        samples: pcm,
      });
    });
    this.#heartbeat = setInterval(() => this.#emit('heartbeat'), this.o.heartbeatMs);
    this.#emit('heartbeat'); // the call exists and is under observation
  }

  onUpdate(u: TransportUpdate): void {
    void this.#handle(u).catch(() => this.#fail('transport_error'));
  }

  async #handle(u: TransportUpdate): Promise<void> {
    if (this.#finished) return;
    if (u.kind === 'waiting') {
      if (u.delivered) this.#emit('ringing');
    } else if (u.kind === 'accepted') {
      const keys = await this.media.exchangeKeys(u.gB);
      const confirmed = await this.o.transport.confirmCall(this.ref, keys);
      await this.media.connect(confirmed);
    } else if (u.kind === 'signaling') {
      await this.media.receiveSignaling(u.data);
    } else if (u.kind === 'discarded') {
      this.tracker.markEnded(); // the provider told us THIS call is over
      await this.#finish(mapDiscard(u.reason, this.#connected), 'ended');
    }
  }

  async #onMediaConnected(): Promise<void> {
    if (this.#connected || this.#finished) return;
    this.#connected = true;
    this.#connectedAt = performance.now();
    // Inbound audio only opens if PLAYBACK is attached after the connection, while a continuous outbound stream runs (F-8).
    this.#pump = this.o.startTicker(() => this.#tick(), 10);
    try {
      await this.media.attachPlayback();
    } catch {
      await this.#fail('transport_error');
      return;
    }
    this.#emit('connected');
  }

  /** One 10 ms tick: real audio when buffered, otherwise silence so the outbound stream stays continuous. */
  #tick(): void {
    if (this.#finished) return;
    const chunk = this.#take();
    void this.media.sendFrame(chunk).catch(() => undefined);
  }
  #take(): Uint8Array {
    if (this.#outboundBytes < FRAME_BYTES) return new Uint8Array(FRAME_BYTES);
    const out = new Uint8Array(FRAME_BYTES);
    let filled = 0;
    while (filled < FRAME_BYTES) {
      const head = this.#outbound[0]!;
      const n = Math.min(head.length, FRAME_BYTES - filled);
      out.set(head.subarray(0, n), filled);
      filled += n;
      if (n === head.length) this.#outbound.shift();
      else this.#outbound[0] = head.subarray(n);
    }
    this.#outboundBytes -= FRAME_BYTES;
    if (this.#outboundBytes < (this.o.maxOutboundMs / 2) * 96) this.#releaseDrain();
    return out;
  }
  #releaseDrain(): void {
    const w = this.#drainWaiters;
    this.#drainWaiters = [];
    for (const r of w) r();
  }

  #emit(type: CallEvent['type'], reason?: CallEndReason): void {
    this.#events.push({
      eventId: `${this.ref.id}-${type}-${this.#eventSeq++}`,
      type,
      occurredAt: this.o.now().toISOString(),
      providerCallId: this.ref.id,
      ...(reason ? { reason } : {}),
    });
  }

  async #finish(reason: CallEndReason, type: 'ended' | 'error'): Promise<void> {
    if (this.#finished) return;
    this.#finished = true;
    this.#pump?.stop();
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#unsubscribe?.();
    this.#releaseDrain();
    this.#emit(type, reason);
    await this.media.stop().catch(() => undefined);
    this.#events.close();
    this.#incoming.close();
    this.onFinished(this.ref.id);
  }

  /** Hang up at Telegram. The end is only reported once the server accepted our discard (or told us the call is over). */
  #hangup(reason: CallEndReason): Promise<void> {
    this.#ending ??= (async () => {
      if (this.#finished) return;
      const seconds = this.#connectedAt === null ? 0 : Math.round((performance.now() - this.#connectedAt) / 1000);
      try {
        await this.o.transport.discardCall(this.ref, { durationSeconds: seconds, kind: DISCARD_KIND[reason] ?? 'hangup' });
      } catch (e) {
        this.tracker.markEndUnproven();
        this.#ending = null; // a later end() may try again
        throw e;
      }
      this.tracker.markEnded();
      await this.#finish(reason, 'ended');
    })();
    return this.#ending;
  }

  async #fail(reason: CallEndReason): Promise<void> {
    try {
      await this.#hangup(reason);
    } catch {
      /* not provably ended: no terminal event; heartbeats continue so the orchestrator's reconcile decides */
    }
  }

  handle(): CallHandle {
    return {
      callId: this.plan.callRequestId,
      incomingAudio: this.#incoming,
      events: this.#events,
      sendAudio: async (frame) => {
        if (this.#finished) return;
        if (frame.sampleRateHz !== SAMPLE_RATE || frame.channels !== 1 || frame.encoding !== 's16le')
          throw new Error('adapter audio must be 48 kHz mono s16le (resample in the audio bridge)');
        if (frame.samples.length === 0 || frame.samples.length % FRAME_BYTES !== 0)
          throw new Error(`adapter audio must be a multiple of 10 ms (${FRAME_BYTES} bytes)`);
        while (this.#outboundBytes > this.o.maxOutboundMs * 96 && !this.#finished) await new Promise<void>((r) => this.#drainWaiters.push(r));
        this.#outbound.push(frame.samples);
        this.#outboundBytes += frame.samples.length;
      },
      flushOutput: async () => {
        this.#outbound = [];
        this.#outboundBytes = 0;
        this.#releaseDrain();
      },
      end: (reason) => this.#hangup(reason),
    };
  }
}
