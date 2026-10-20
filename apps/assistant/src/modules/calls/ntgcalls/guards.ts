import type { RtcServer } from './ports.js';

// Placement and update-binding safety for the production ntgcalls adapter (port of experiments/telegram-calls/call-guards.mjs, audit F05/F06).

export const PHASE = {
  NOT_SUBMITTED: 'not_submitted', // no RequestCall left this process, or the server rejected it (provably not placed)
  SUBMITTED_UNKNOWN: 'submitted_unknown', // RequestCall may have reached Telegram; the outcome is unknown
  CONFIRMED: 'confirmed', // Telegram returned our call id
  ENDED_CONFIRMED: 'ended_confirmed', // the provider confirmed the call is over
  ENDED_UNPROVEN: 'ended_unproven', // we tried to hang up but cannot prove it ended
} as const;
export type Phase = (typeof PHASE)[keyof typeof PHASE];

/** A GramJS RPCError carries `errorMessage`: the server answered, so the request was rejected rather than lost. */
export const serverErrorMessage = (e: unknown): string | null => {
  if (!e || typeof e !== 'object') return null;
  const m = (e as { errorMessage?: unknown }).errorMessage;
  return typeof m === 'string' && m.length > 0 ? m : null;
};

export class PlacementTracker {
  phase: Phase = PHASE.NOT_SUBMITTED;
  requestCalls = 0;
  /** Call BEFORE awaiting RequestCall: from here on a timeout cannot prove the call was not placed. */
  markSubmitted(): void {
    this.requestCalls++;
    this.phase = PHASE.SUBMITTED_UNKNOWN;
  }
  markSubmitFailed(e: unknown): void {
    if (serverErrorMessage(e)) this.phase = PHASE.NOT_SUBMITTED; // the server answered: nothing was placed
  }
  markConfirmed(): void {
    this.phase = PHASE.CONFIRMED;
  }
  markEnded(): void {
    this.phase = PHASE.ENDED_CONFIRMED;
  }
  markEndUnproven(): void {
    if (this.phase !== PHASE.ENDED_CONFIRMED) this.phase = PHASE.ENDED_UNPROVEN;
  }
}

export interface CallRef {
  id: string;
  accessHash: string;
}

export type TransportUpdate =
  | { kind: 'waiting'; id: string; delivered: boolean; adminId?: string | undefined; participantId?: string | undefined }
  | { kind: 'accepted'; id: string; gB: Uint8Array; adminId?: string | undefined; participantId?: string | undefined }
  | { kind: 'discarded'; id: string; reason: string; adminId?: string | undefined; participantId?: string | undefined }
  | { kind: 'signaling'; id: string; data: Uint8Array }
  /** Someone is calling this account (incoming ring). `gAHash` commits the caller to its half of the key exchange. */
  | { kind: 'requested'; id: string; accessHash: string; gAHash: Uint8Array; video: boolean; adminId?: string | undefined; participantId?: string | undefined }
  /** The final call object: for the party that ACCEPTED, it carries the caller's `g_a`, the key fingerprint and the relay servers. */
  | {
      kind: 'confirmed';
      id: string;
      gAOrB: Uint8Array;
      keyFingerprint: bigint;
      servers: RtcServer[];
      versions: string[];
      p2pAllowed: boolean;
      customParameters: string;
      adminId?: string | undefined;
      participantId?: string | undefined;
    };

/**
 * Binds incoming updates to the ONE call this process placed. Until RequestCall returns our call id, relevant updates are held in a
 * small bounded buffer and replayed only if they belong to our call. Anything else (an unrelated incoming call, a concurrent call)
 * is ignored and can never become the cleanup target.
 */
export class CallUpdateGate {
  bound: CallRef | null = null;
  droppedEarly = 0;
  #early: TransportUpdate[] = [];
  /** `adminId` is who placed the call, `participantId` who was called: (us, recipient) for our own calls, (caller, us) for one we answer. */
  constructor(
    private readonly adminId: string,
    private readonly participantId: string,
    private readonly maxBuffered = 20,
  ) {}
  #participantsOk(u: TransportUpdate): boolean {
    if (u.kind === 'signaling') return true;
    if (u.adminId !== undefined && u.adminId !== this.adminId) return false;
    if (u.participantId !== undefined && u.participantId !== this.participantId) return false;
    return true;
  }
  classify(u: TransportUpdate): 'accept' | 'buffer' | 'ignore' {
    if (!this.bound) return 'buffer';
    if (u.id !== this.bound.id) return 'ignore';
    return this.#participantsOk(u) ? 'accept' : 'ignore';
  }
  buffer(u: TransportUpdate): void {
    if (this.#early.length >= this.maxBuffered) {
      this.droppedEarly++;
      return;
    }
    this.#early.push(u);
  }
  /** Bind to the call returned by RequestCall; returns the buffered updates that belong to it, in order. */
  bind(ref: CallRef): TransportUpdate[] {
    this.bound = ref;
    const mine = this.#early.filter((u) => u.id === ref.id && this.#participantsOk(u));
    this.droppedEarly += this.#early.length - mine.length;
    this.#early = [];
    return mine;
  }
}
