// Pure, offline-testable safety logic for live-call.mjs (audit F05/F06). No Telegram, no ntgcalls, no I/O.

export const PHASE = Object.freeze({
  NOT_SUBMITTED: 'not_submitted', // no RequestCall left this process, or the server rejected it (provably not placed)
  SUBMITTED_UNKNOWN: 'submitted_unknown', // RequestCall may have reached Telegram; we do not know the outcome
  CONFIRMED: 'confirmed', // Telegram returned our call id
  ENDED_CONFIRMED: 'ended_confirmed', // the provider confirmed the call is over (discard update or accepted DiscardCall)
  ENDED_UNPROVEN: 'ended_unproven', // we tried to hang up but cannot prove it ended
});

/** A GramJS RPCError carries `errorMessage`: the server answered, so the request was rejected rather than lost. */
export const isServerRejection = (e) => !!e && typeof e === 'object' && typeof e.errorMessage === 'string' && e.errorMessage.length > 0;

export class PlacementTracker {
  phase = PHASE.NOT_SUBMITTED;
  requestCalls = 0;
  /** Call BEFORE awaiting RequestCall: from here on a timeout cannot prove the call was not placed. */
  markSubmitted() {
    this.requestCalls++;
    this.phase = PHASE.SUBMITTED_UNKNOWN;
  }
  markSubmitFailed(e) {
    if (isServerRejection(e)) this.phase = PHASE.NOT_SUBMITTED; // e.g. USER_PRIVACY_RESTRICTED: nothing was placed
    // otherwise (timeout, socket loss, anything unexplained) stay SUBMITTED_UNKNOWN
  }
  markConfirmed() {
    this.phase = PHASE.CONFIRMED;
  }
  markEnded() {
    this.phase = PHASE.ENDED_CONFIRMED;
  }
  markEndUnproven() {
    if (this.phase !== PHASE.ENDED_CONFIRMED) this.phase = PHASE.ENDED_UNPROVEN;
  }
}

const SAFE_TO_CONTINUE = new Set([PHASE.NOT_SUBMITTED, PHASE.ENDED_CONFIRMED]);

/**
 * Run `repeat` placements. Before EVERY placement the authorization window is re-checked. After a placement the batch continues
 * only if the call is provably over or provably never placed; anything else aborts the whole batch (never redial an uncertain call).
 */
export async function runBatch({ repeat, checkWindow, place, pause }) {
  const results = [];
  for (let n = 1; n <= repeat; n++) {
    const problem = checkWindow();
    if (problem) return { results, aborted: problem };
    const r = await place(n);
    results.push(r);
    if (!SAFE_TO_CONTINUE.has(r.placement))
      return { results, aborted: `call ${n} left in "${r.placement}": the outcome is uncertain or the call is not proven ended; no further placements` };
    if (n < repeat) await pause();
  }
  return { results, aborted: null };
}

export function parseIntInRange(raw, min, max, name) {
  const s = raw === undefined || raw === '' ? undefined : String(raw);
  if (s === undefined) return { error: `${name} is required` };
  if (!/^-?\d+$/.test(s)) return { error: `${name} must be an integer` };
  const v = Number(s);
  if (v < min || v > max) return { error: `${name} must be between ${min} and ${max}` };
  return { value: v };
}

/** ntgcalls external audio must be an integer multiple of 10 ms; 20 ms distorted in the first live run, 10 ms was clean. */
export function parseFrameMs(raw) {
  if (raw === undefined || raw === '') return { value: 10 };
  const r = parseIntInRange(raw, 10, 60, 'LIVE_TEST_FRAME_MS');
  if (r.error) return r;
  if (r.value % 10 !== 0) return { error: 'LIVE_TEST_FRAME_MS must be a multiple of 10 (ms)' };
  return r;
}

export function windowProblem(nowMs, startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 'LIVE_TEST_WINDOW_START and LIVE_TEST_WINDOW_END (ISO instants) are required';
  if (endMs <= startMs) return 'the test window must be positive';
  if (endMs - startMs > 2 * 3600_000) return 'the test window must be at most 2 hours';
  if (nowMs < startMs || nowMs > endMs) return `now (${new Date(nowMs).toISOString()}) is outside the authorized test window`;
  return null;
}

const idStr = (v) => (v === undefined || v === null ? '' : String(v));

/**
 * Binds incoming updates to the ONE call this process placed. Before the RequestCall response identifies the call, updates are
 * held in a small bounded buffer and replayed only if they turn out to belong to our call. Anything else (an unrelated incoming
 * call, a concurrent call, late duplicates of another call) is ignored and can never become the cleanup target.
 */
export class CallUpdateGate {
  bound = null; // { id, accessHash }
  droppedEarly = 0;
  #early = [];
  constructor({ selfId, recipientId, maxBuffered = 20 }) {
    this.selfId = idStr(selfId);
    this.recipientId = idStr(recipientId);
    this.maxBuffered = maxBuffered;
  }
  #participantsOk(pc) {
    // Only constrain when the fields are present (PhoneCallWaiting/Accepted/PhoneCall carry both).
    if (pc.adminId !== undefined && idStr(pc.adminId) !== this.selfId) return false;
    if (pc.participantId !== undefined && idStr(pc.participantId) !== this.recipientId) return false;
    return true;
  }
  classifyPhoneCall(pc) {
    if (!pc || pc.className === 'PhoneCallRequested') return 'ignore'; // we never answer incoming calls
    if (!this.bound) return pc.className === 'PhoneCallAccepted' || pc.className === 'PhoneCallDiscarded' ? 'buffer' : 'ignore';
    if (idStr(pc.id) !== idStr(this.bound.id)) return 'ignore';
    return this.#participantsOk(pc) ? 'accept' : 'ignore';
  }
  classifySignaling(u) {
    if (!this.bound) return 'buffer';
    return idStr(u?.phoneCallId) === idStr(this.bound.id) ? 'accept' : 'ignore';
  }
  buffer(update) {
    if (this.#early.length >= this.maxBuffered) {
      this.droppedEarly++;
      return;
    }
    this.#early.push(update);
  }
  /** Bind to the call returned by RequestCall; returns the buffered updates that belong to it, in order. */
  bind(pc) {
    this.bound = { id: pc.id, accessHash: pc.accessHash };
    const mine = this.#early.filter((u) => idStr(u.id ?? u.phoneCallId) === idStr(pc.id));
    this.droppedEarly += this.#early.length - mine.length;
    this.#early = [];
    return mine;
  }
  cleanupTarget() {
    return this.bound;
  }
}

/** G0-E needs an operator-declared expected reason: the mapping decline/busy -> discard reason is not assumed. */
export function g0eVerdict({ scenario, discardReason, expectedReason, requestCalls, accepted, connected }) {
  const noRedial = requestCalls === 1;
  const reasonMatches = discardReason !== null && discardReason === expectedReason;
  return {
    scenario,
    expectedReason,
    discardReason,
    requestCalls,
    noRedial,
    ok: reasonMatches && noRedial && !accepted && !connected,
    note: 'decline and busy may produce the same discard class; the operator attests which situation was created',
  };
}
