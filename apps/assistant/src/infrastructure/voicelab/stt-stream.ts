import WebSocket from 'ws';

/**
 * VoiceLab live speech recognition over WebSocket (docs.voicelab.uz/api/realtime-stt):
 *   wss://api.voicelab.uz/v1/stt/stream, handshake header `xvl-api-key` (key permission stt:realtime; stt:write is not enough).
 *   1. wait for {"event":"ready"}   2. send {"type":"start", language, audio_format:"pcm_s16le", sample_rate, channels:1, word_timestamps}
 *   3. send headerless PCM16 little-endian mono as binary frames   4. {"type":"commit"} at the end of an utterance (100 ms - 35 s of audio per commit)
 *   5. {"event":"final","text":...}. There are no interim results. {"action":"interrupt"} cancels what is in flight.
 * Written from the vendor's documentation as given to us; NOT live verified from the build sandbox (voicelab.uz is unreachable there).
 */
export interface SttFinal {
  text: string;
  language?: string | undefined;
}

export interface SttStreamOptions {
  apiKey: string;
  url: string;
  language: string;
  sampleRateHz: number;
  /** Test seam. */
  socketFactory?: ((url: string, headers: Record<string, string>) => WebSocket) | undefined;
  maxReconnects?: number | undefined;
  /** Event names only (never audio, text or keys); used to learn what the server really sends. */
  log?: ((line: string) => void) | undefined;
  /** How long to wait after `start` (the server sends no acknowledgement we know of) before audio follows. */
  startWaitMs?: number | undefined;
}

const MAX_QUEUED_MS = 5_000;
const ERROR_REPEAT_MS = 5_000;
const FINAL_TIMEOUT_MS = 8_000;
const COMMIT = Symbol('commit');

export const STT_MIN_COMMIT_MS = 100;
export const STT_MAX_COMMIT_MS = 35_000;

export interface SttStream {
  sendAudio(pcm: Uint8Array): void;
  /** Ends the utterance. Returns false (and sends nothing) if less than 100 ms of audio is waiting. */
  commit(): boolean;
  /** Drops the audio waiting and any recognition in flight. */
  interrupt(): void;
  onFinal(cb: (f: SttFinal) => void): void;
  onError(cb: (m: string) => void): void;
  close(): void;
}

/**
 * Observed behaviour (live log): `ready` arrives once; `start` is not acknowledged; a session handles ONE utterance - after `final`, after
 * `interrupt` the server answers `not_started` to audio until a new `start`, and `busy` if audio/commit arrives while a transcription is
 * still running. So: every utterance opens with its own `start`, nothing is sent while a result is pending, and extra audio waits in a
 * bounded queue.
 */
export class VoiceLabSttStream implements SttStream {
  #ws!: WebSocket;
  #ready = false; // server said `ready` on this connection
  #open = false; // a `start` was sent and the session has not ended
  #warming = false; // `start` sent, short wait before audio
  #inFlight = false; // committed, `final` not back yet
  #dead = false; // the server refused the start again and again: off for this call
  #notStarted: number[] = [];
  #startTimer: ReturnType<typeof setTimeout> | undefined;
  #flightTimer: ReturnType<typeof setTimeout> | undefined;
  #seen = new Set<string>();
  #lastError = { msg: '', at: 0, n: 0 };
  #closed = false;
  #queue: Array<typeof COMMIT | Uint8Array> = [];
  #pendingMs = 0; // audio accepted for the current utterance
  #finals: Array<(f: SttFinal) => void> = [];
  #errors: Array<(m: string) => void> = [];
  #reconnects = 0;

  constructor(private readonly o: SttStreamOptions) {
    this.#connect();
  }

  #scrub(s: string): string {
    return s.split(this.o.apiKey).join('***').slice(0, 300);
  }
  #emitError(m: string): void {
    const msg = this.#scrub(m);
    const now = Date.now();
    if (msg === this.#lastError.msg && now - this.#lastError.at < ERROR_REPEAT_MS) {
      this.#lastError.n++; // the same complaint again: counted, not repeated
      return;
    }
    const more = this.#lastError.n > 0 ? ` (previous error repeated ${this.#lastError.n}x)` : '';
    this.#lastError = { msg, at: now, n: 0 };
    for (const cb of this.#errors) cb(msg + more);
  }

  #resetSession(): void {
    this.#open = false;
    this.#warming = false;
    this.#inFlight = false;
    clearTimeout(this.#startTimer);
    clearTimeout(this.#flightTimer);
  }

  #connect(): void {
    const headers = { 'xvl-api-key': this.o.apiKey };
    const ws = this.o.socketFactory ? this.o.socketFactory(this.o.url, headers) : new WebSocket(this.o.url, { headers });
    this.#ws = ws;
    this.#ready = false;
    this.#resetSession();
    ws.on('message', (raw: WebSocket.RawData, isBinary?: boolean) => {
      if (isBinary) return;
      this.#onMessage(raw.toString());
    });
    ws.on('error', (e: Error) => this.#emitError(`stt websocket: ${e.message}`));
    ws.on('close', (code: number, reason: Buffer) => {
      if (this.#closed || ws !== this.#ws) return;
      if (this.#reconnects < (this.o.maxReconnects ?? 2)) {
        this.#reconnects++;
        this.#pendingMs = 0; // the audio of a lost connection can not be recovered
        this.#queue = [];
        this.#connect();
        return;
      }
      this.#emitError(`stt websocket closed (${code}) ${reason.toString()}`.trim());
    });
  }

  #bound(): void {
    const ms = (x: Uint8Array) => (x.length / 2 / this.o.sampleRateHz) * 1000;
    let total = 0;
    for (const q of this.#queue) if (q !== COMMIT) total += ms(q);
    while (total > MAX_QUEUED_MS) {
      const i = this.#queue.findIndex((q) => q !== COMMIT);
      if (i < 0) break;
      const d = this.#queue.splice(i, 1)[0] as Uint8Array;
      total -= ms(d);
      this.#pendingMs = Math.max(0, this.#pendingMs - ms(d));
    }
  }

  /** Sends what may be sent now: a fresh `start` first when the session is closed, then audio, stopping after a commit. */
  #pump(): void {
    if (this.#dead || !this.#ready || this.#inFlight || this.#warming || !this.#queue.length) return;
    if (!this.#open) {
      this.#open = true;
      this.#warming = true;
      this.#ws.send(
        JSON.stringify({
          type: 'start',
          language: this.o.language,
          audio_format: 'pcm_s16le',
          sample_rate: this.o.sampleRateHz,
          channels: 1,
          word_timestamps: true,
        }),
      );
      this.#startTimer = setTimeout(() => this.#started(), this.o.startWaitMs ?? 300);
      return;
    }
    while (this.#queue.length) {
      const x = this.#queue.shift()!;
      if (x === COMMIT) {
        this.#ws.send(JSON.stringify({ type: 'commit' }));
        this.#inFlight = true;
        clearTimeout(this.#flightTimer);
        this.#flightTimer = setTimeout(() => this.#giveUpWaiting(), FINAL_TIMEOUT_MS);
        return;
      }
      this.#ws.send(x);
    }
  }

  #started(): void {
    clearTimeout(this.#startTimer);
    this.#warming = false;
    this.#pump();
  }

  #giveUpWaiting(): void {
    this.#emitError('stt: no result came back in time');
    try {
      this.#ws.send(JSON.stringify({ action: 'interrupt' }));
    } catch {
      /* socket gone */
    }
    this.#resetSession();
    this.#pump();
  }

  #onMessage(raw: string): void {
    let m: { event?: string; type?: string; text?: unknown; language?: unknown; message?: unknown; error?: unknown; code?: unknown };
    try {
      m = JSON.parse(raw) as typeof m;
    } catch {
      return;
    }
    const kind = String(m.event ?? m.type ?? '?').slice(0, 40);
    if (!this.#seen.has(kind)) {
      this.#seen.add(kind);
      this.o.log?.(`stt event: ${kind}`);
    }
    if (this.#warming && kind !== 'ready' && kind !== 'error') this.#started(); // any non-error answer to `start` means it was accepted
    switch (kind) {
      case 'ready':
        this.#ready = true;
        this.#resetSession();
        this.#pump();
        break;
      case 'final':
        this.#resetSession(); // the session handled its utterance: the next one opens with a new `start`
        if (typeof m.text === 'string')
          for (const cb of this.#finals) cb({ text: m.text, ...(typeof m.language === 'string' ? { language: m.language } : {}) });
        this.#pump();
        break;
      case 'error': {
        const why = [m.code, m.message ?? m.error].filter((x) => typeof x === 'string').join(': ');
        if (m.code === 'not_started') {
          // the session is over (after interrupt / final / a lost start): drop what was sent into it and open a new one with the next audio
          const now = Date.now();
          this.#notStarted = this.#notStarted.filter((t) => now - t < 3_000);
          this.#notStarted.push(now);
          this.#pendingMs = 0;
          this.#queue = [];
          this.#resetSession();
          if (this.#notStarted.length >= 10 && !this.#dead) {
            this.#dead = true;
            this.#emitError('stt: the server keeps refusing the start message; speech recognition is off for this call');
          }
          break;
        }
        if (m.code === 'busy') break; // our commit/audio crossed a running transcription; the queue holds the rest
        if (typeof m.code === 'string' && m.code.includes('already')) {
          this.#open = true;
          break;
        }
        this.#emitError(`stt error${why ? `: ${why}` : ''}`);
        if (this.#inFlight) {
          this.#resetSession(); // a rejected commit gets no `final`
          this.#pump();
        }
        break;
      }
      default:
    }
  }

  sendAudio(pcm: Uint8Array): void {
    if (!pcm.length || this.#dead) return;
    this.#pendingMs += (pcm.length / 2 / this.o.sampleRateHz) * 1000;
    this.#queue.push(pcm);
    this.#bound();
    this.#pump();
  }

  commit(): boolean {
    if (this.#dead || this.#pendingMs < STT_MIN_COMMIT_MS) return false;
    this.#pendingMs = 0;
    this.#queue.push(COMMIT);
    this.#pump();
    return true;
  }

  get pendingMs(): number {
    return this.#pendingMs;
  }

  interrupt(): void {
    this.#pendingMs = 0;
    this.#queue = []; // audio and commits that never left
    if (this.#ready && (this.#open || this.#inFlight)) this.#ws.send(JSON.stringify({ action: 'interrupt' }));
    this.#resetSession();
  }

  onFinal(cb: (f: SttFinal) => void): void {
    this.#finals.push(cb);
  }
  onError(cb: (m: string) => void): void {
    this.#errors.push(cb);
  }
  close(): void {
    this.#closed = true;
    this.#resetSession();
    try {
      this.#ws.close();
    } catch {
      /* already closed */
    }
  }
}
