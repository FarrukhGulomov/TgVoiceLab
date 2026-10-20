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
  /** Stage names and error messages of an answered call (never audio, ids or names). */
  log?: ((line: string) => void) | undefined;
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

/** An incoming ring the adapter has not answered yet. */
export interface IncomingCall {
  ref: CallRef;
  /** Numeric Telegram id of the caller (identity is the id, never a name). */
  callerId: string;
  gAHash: Uint8Array;
}

export class NtgcallsCallAdapter implements TelegramCallAdapter {
  readonly #o: Required<Omit<NtgcallsAdapterOptions, 'transport' | 'media' | 'buildFingerprint' | 'log'>> & NtgcallsAdapterOptions;
  #active: ActiveCall | null = null;
  readonly #ended = new Set<string>();
  /** Incoming rings that were handed to the application and wait to be answered by `dial` (keyed by the call request made for them). */
  readonly #pendingIncoming = new Map<string, IncomingCall>();
  #listening: (() => void) | null = null;

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
      privateInbound: true,
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

  /**
   * Starts watching for incoming rings. `onIncoming` is called for a ring this adapter is free to take (audio only, nothing else going on); it
   * must either `registerIncoming` the call for a later `dial` or `declineIncoming` it. Rings that arrive while a call is active or another ring
   * is waiting are declined as busy here. The adapter never answers by itself.
   */
  listenForIncoming(onIncoming: (c: IncomingCall) => void | Promise<void>): void {
    if (this.#listening) return;
    const o = this.#o;
    this.#listening = o.transport.subscribe((u) => {
      if (u.kind !== 'requested') return;
      if (u.participantId !== undefined && u.participantId !== o.transport.selfId) return; // not addressed to this account
      if (!u.adminId) return;
      const call: IncomingCall = { ref: { id: u.id, accessHash: u.accessHash }, callerId: u.adminId, gAHash: u.gAHash };
      if (u.video || this.#active || this.#pendingIncoming.size > 0) {
        void this.declineIncoming(call, u.video ? 'hangup' : 'busy');
        return;
      }
      void Promise.resolve(onIncoming(call)).catch(() => this.declineIncoming(call, 'hangup'));
    });
  }

  stopListening(): void {
    this.#listening?.();
    this.#listening = null;
  }

  /** Reserves a ring for the call request that will answer it; `dial` of that request's plan answers instead of placing a call. */
  registerIncoming(callRequestId: string, call: IncomingCall): void {
    this.#pendingIncoming.set(callRequestId, call);
  }

  /** Takes back a ring that was never answered (the request was refused before `dial`). Returns it so the caller can decline it. */
  releaseIncoming(callRequestId: string): IncomingCall | undefined {
    const c = this.#pendingIncoming.get(callRequestId);
    this.#pendingIncoming.delete(callRequestId);
    return c;
  }

  async declineIncoming(call: IncomingCall, kind: DiscardKind = 'busy'): Promise<void> {
    await this.#o.transport.discardCall(call.ref, { durationSeconds: 0, kind }).catch(() => undefined);
  }

  async dial(plan: ApprovedCallPlan, signal: AbortSignal): Promise<CallHandle> {
    const incoming = this.#pendingIncoming.get(plan.callRequestId);
    if (incoming) {
      this.#pendingIncoming.delete(plan.callRequestId);
      return this.#answer(plan, incoming, signal);
    }
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

  /** Answers a ring: our half of the key exchange goes out with AcceptCall; the caller's half arrives later as a `confirmed` update. */
  async #answer(plan: ApprovedCallPlan, incoming: IncomingCall, signal: AbortSignal): Promise<CallHandle> {
    const o = this.#o;
    if (plan.recipientTelegramId !== incoming.callerId) {
      void this.declineIncoming(incoming, 'hangup');
      throw new DialRejectedError('transport_error', 'the plan is for someone else than the caller');
    }
    if (this.#active || signal.aborted) {
      void this.declineIncoming(incoming, 'busy');
      throw new DialRejectedError(signal.aborted ? 'cancelled' : 'transport_error', signal.aborted ? undefined : 'the call adapter already has an active call');
    }
    const tracker = new PlacementTracker();
    const gate = new CallUpdateGate(incoming.callerId, o.transport.selfId);
    const media = o.media();
    const call = new ActiveCall(plan, media, tracker, o, (id) => {
      this.#ended.add(id);
      if (this.#ended.size > 200) this.#ended.delete(this.#ended.values().next().value as string);
      if (this.#active === call) this.#active = null;
    });
    this.#active = call;
    gate.bind(incoming.ref);
    call.attachUnsubscribe(
      o.transport.subscribe((u) => {
        if (gate.classify(u) === 'accept') call.onUpdate(u);
      }),
    );
    const fail = async (why: string, e?: unknown): Promise<never> => {
      call.releaseTransport();
      await media.stop().catch(() => undefined);
      this.#active = null;
      void this.declineIncoming(incoming, 'hangup');
      const rejected = e === undefined ? null : mapRequestCallError(e);
      throw rejected ?? new DialRejectedError('transport_error', why);
    };
    let gB: Uint8Array;
    try {
      const dh = await o.transport.getDhConfig();
      gB = await media.answer(dh, incoming.gAHash);
      o.log?.('answer: key exchange prepared');
    } catch (e) {
      o.log?.(`answer: could not prepare (${String((e as Error)?.message ?? e).slice(0, 120)})`);
      return fail('could not prepare to answer the call (DH config / media setup)', e);
    }
    if (signal.aborted) return fail('cancelled');
    await o.transport.receivedCall(incoming.ref).catch(() => undefined); // best effort: only changes what the caller's app shows
    try {
      await o.transport.acceptCall(incoming.ref, { gB });
      o.log?.("answer: AcceptCall sent, waiting for the caller's key");
    } catch (e) {
      o.log?.(`answer: AcceptCall failed (${serverErrorMessage(e) ?? String((e as Error)?.message ?? e).slice(0, 120)})`);
      return fail('telegram did not accept the answer (the caller may have hung up)', e);
    }
    tracker.markConfirmed();
    call.start(incoming.ref, 'answerer');
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
  releaseTransport(): void {
    this.#unsubscribe?.();
  }

  #role: 'caller' | 'answerer' = 'caller';

  start(ref: CallRef, role: 'caller' | 'answerer' = 'caller'): void {
    this.ref = ref;
    this.#role = role;
    this.media.onSignaling((data) => {
      if (this.#sigOut++ === 0) this.o.log?.('signaling: first packet to the other side');
      void this.o.transport.sendSignaling(ref, data).catch((e: unknown) => {
        this.o.log?.(`signaling: sending failed (${serverErrorMessage(e) ?? String((e as Error)?.message ?? e).slice(0, 100)})`);
      });
    });
    this.media.onState((s) => {
      this.o.log?.(`media state: ${s}`);
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
    if (role === 'answerer') this.#emit('ringing'); // we are the ones ringing until the media connects
  }

  /**
   * Updates of one call are handled strictly one after another, in the order they arrived: the caller's connection data (signaling) comes
   * right behind its key, and handing it to the media layer before the key exchange and `connect` finished loses it, so the two sides never meet.
   */
  #updates: Promise<void> = Promise.resolve();
  #sigIn = 0;
  #sigOut = 0;
  onUpdate(u: TransportUpdate): void {
    this.#updates = this.#updates.then(() =>
      this.#handle(u).catch((e: unknown) => {
        this.o.log?.(`call update '${u.kind}' failed (${String((e as Error)?.message ?? e).slice(0, 120)})`);
        return this.#fail('transport_error');
      }),
    );
  }

  async #handle(u: TransportUpdate): Promise<void> {
    if (this.#finished) return;
    if (u.kind === 'waiting') {
      if (u.delivered) this.#emit('ringing');
    } else if (u.kind === 'accepted') {
      const keys = await this.media.exchangeKeys(u.gB);
      const confirmed = await this.o.transport.confirmCall(this.ref, keys);
      await this.media.connect(confirmed);
    } else if (u.kind === 'confirmed' && this.#role === 'answerer') {
      this.o.log?.("answer: the caller's key arrived");
      const keys = await this.media.exchangeKeys(u.gAOrB, u.keyFingerprint);
      // The key both sides derived must carry the fingerprint the caller announced; anything else means the exchange was tampered with or broken.
      if (keys.keyFingerprint !== u.keyFingerprint) throw new Error('key fingerprint mismatch');
      await this.media.connect({ servers: u.servers, versions: u.versions, p2pAllowed: u.p2pAllowed, customParameters: u.customParameters });
      this.o.log?.('answer: media connecting');
    } else if (u.kind === 'signaling') {
      if (this.#sigIn++ === 0) this.o.log?.('signaling: first packet from the other side');
      await this.media.receiveSignaling(u.data);
    } else if (u.kind === 'discarded') {
      this.o.log?.(`call discarded by the other side (${u.reason})`);
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
      drained: async () => {
        const deadline = Date.now() + 15_000; // bounded: a stuck pump must not hold the caller forever
        while (this.#outboundBytes >= FRAME_BYTES && !this.#finished && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
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
