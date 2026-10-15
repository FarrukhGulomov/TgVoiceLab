/**
 * FAKES — for tests and explicit development mode ONLY. Nothing here is evidence of a real integration, and
 * config validation refuses these in production. Names are deliberately loud.
 */
import type { MessagingPort, OutboundMessage } from '../application/ports.js';

export class FakeMessaging implements MessagingPort {
  readonly sent: Array<OutboundMessage & { providerMessageId: string }> = [];
  failNext = 0;
  private readonly byKey = new Map<string, string>();
  /** Mimics Telegram's random_id dedupe: same key -> same message, no second send. */
  async sendMessage(m: OutboundMessage) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('FAKE transient send failure');
    }
    const prior = this.byKey.get(m.idempotencyKey);
    if (prior) return { providerMessageId: prior };
    const id = `fake-${this.sent.length + 1}`;
    this.byKey.set(m.idempotencyKey, id);
    this.sent.push({ ...m, providerMessageId: id });
    return { providerMessageId: id };
  }
}

import type {
  ApprovedCallPlan,
  CallEvent,
  CallHandle,
  CallAdapterCapabilities,
  PcmFrame,
  ReconcileResult,
  TelegramCallAdapter,
  CallEndReason,
} from '@tgvl/contracts';
import { DialOutcomeUnknownError, DialRejectedError } from '@tgvl/contracts';

export type FakeCallScript =
  | { kind: 'answer'; holdMs?: number }
  | { kind: 'no_answer' }
  | { kind: 'reject'; reason: CallEndReason; retryAfterSeconds?: number }
  | { kind: 'unknown_outcome'; providerCallId?: string }
  | { kind: 'hang_in_dial' }
  | { kind: 'event_stream_dies' }
  | { kind: 'duplicate_events' };

/** FAKE call adapter. Scripted behaviors for tests; its events are synthetic and can never count as live evidence. */
export class FakeCallAdapter implements TelegramCallAdapter {
  script: FakeCallScript = { kind: 'answer' };
  readonly dials: ApprovedCallPlan[] = [];
  readonly ended: Array<{ callId: string; reason: CallEndReason }> = [];
  reconcileResult: ReconcileResult = 'unknown';
  async capabilities(): Promise<CallAdapterCapabilities> {
    return { privateOutbound: true, privateInbound: false, pcmSend: true, pcmReceive: true, evidenceArtifact: 'FAKE', buildFingerprint: 'fake' };
  }
  async reconcile(): Promise<ReconcileResult> {
    return this.reconcileResult;
  }
  async dial(plan: ApprovedCallPlan, signal: AbortSignal): Promise<CallHandle> {
    this.dials.push(plan);
    const s = this.script;
    if (s.kind === 'reject') throw new DialRejectedError(s.reason, undefined, s.retryAfterSeconds);
    if (s.kind === 'unknown_outcome') throw new DialOutcomeUnknownError('socket closed after request', s.providerCallId);
    if (s.kind === 'hang_in_dial')
      await new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted while dialing')), { once: true }));

    const queue: CallEvent[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    const push = (e: Omit<CallEvent, 'eventId' | 'occurredAt'> & { eventId?: string }) => {
      queue.push({ eventId: e.eventId ?? `${e.type}-${queue.length}`, occurredAt: new Date().toISOString(), ...e } as CallEvent);
      wake?.();
    };
    const close = () => {
      closed = true;
      wake?.();
    };
    const callId = plan.callRequestId;
    const providerCallId = `fake-provider-${this.dials.length}`;
    const adapterEnded = this.ended;
    const handle: CallHandle = {
      callId,
      incomingAudio: (async function* (): AsyncGenerator<PcmFrame> {
        /* no media in the fake */
      })(),
      events: (async function* () {
        for (;;) {
          while (queue.length) yield queue.shift()!;
          if (closed) return;
          await new Promise<void>((r) => {
            wake = r;
          });
        }
      })(),
      async sendAudio() {},
      async flushOutput() {},
      async end(reason) {
        adapterEnded.push({ callId, reason });
        push({ type: 'ended', reason });
        close();
      },
    };
    queueMicrotask(() => {
      push({ type: 'ringing', providerCallId });
      if (s.kind === 'answer') setTimeout(() => push({ type: 'connected', providerCallId }), 1);
      else if (s.kind === 'no_answer') {
        /* never answers: the orchestrator's ring timeout must fire */
      } else if (s.kind === 'event_stream_dies') setTimeout(close, 5);
      else if (s.kind === 'duplicate_events') {
        push({ type: 'connected', providerCallId, eventId: 'dup-1' });
        push({ type: 'connected', providerCallId, eventId: 'dup-1' });
      }
    });
    return handle;
  }
}
