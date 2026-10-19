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
  /** How long to wait for the server to acknowledge `start` before sending audio anyway. */
  startWaitMs?: number | undefined;
}

const MAX_START_RETRIES = 3;
const MAX_QUEUED_MS = 5_000;
const ERROR_REPEAT_MS = 5_000;

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

export class VoiceLabSttStream implements SttStream {
  #ws!: WebSocket;
  #ready = false; // server said `ready`
  #live = false; // `start` was acknowledged (or the wait ran out): audio may flow
  #dead = false; // start was refused repeatedly: stop streaming, one warning was given
  #startTries = 0;
  #startTimer: ReturnType<typeof setTimeout> | undefined;
  #seen = new Set<string>();
  #lastError = { msg: '', at: 0, n: 0 };
  #closed = false;
  #queue: Array<string | Uint8Array> = []; // everything sent before `ready` (and during a reconnect)
  #pendingMs = 0; // audio sent since the last commit
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

  #start(): void {
    this.#live = false;
    this.#startTries++;
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
    clearTimeout(this.#startTimer);
    // No acknowledgement event is known for certain; if the server stays silent (and does not complain) the session is taken as started.
    this.#startTimer = setTimeout(() => this.#goLive(), this.o.startWaitMs ?? 400);
  }

  #goLive(): void {
    clearTimeout(this.#startTimer);
    if (this.#live || this.#dead || this.#closed) return;
    this.#live = true;
    const q = this.#queue;
    this.#queue = [];
    for (const x of q) this.#ws.send(x);
  }

  #connect(): void {
    const headers = { 'xvl-api-key': this.o.apiKey };
    const ws = this.o.socketFactory ? this.o.socketFactory(this.o.url, headers) : new WebSocket(this.o.url, { headers });
    this.#ws = ws;
    this.#ready = false;
    this.#live = false;
    this.#startTries = 0;
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
        this.#connect();
        return;
      }
      this.#emitError(`stt websocket closed (${code}) ${reason.toString()}`.trim());
    });
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
    if (kind !== 'ready' && kind !== 'error' && !this.#live && this.#ready) this.#goLive(); // any non-error answer to `start` means it was accepted
    switch (kind) {
      case 'ready':
        this.#ready = true;
        this.#start();
        break;
      case 'final':
        if (typeof m.text === 'string')
          for (const cb of this.#finals) cb({ text: m.text, ...(typeof m.language === 'string' ? { language: m.language } : {}) });
        break;
      case 'error': {
        const why = [m.code, m.message ?? m.error].filter((x) => typeof x === 'string').join(': ');
        if (m.code === 'not_started') {
          this.#pendingMs = 0;
          this.#queue = [];
          if (this.#startTries < MAX_START_RETRIES && !this.#dead) {
            this.#start(); // the server did not take our `start`: say it again, hold the audio until it answers
            break;
          }
          if (!this.#dead) {
            this.#dead = true;
            clearTimeout(this.#startTimer);
            this.#emitError('stt: the server keeps refusing the start message; speech recognition is off for this call');
          }
          break;
        }
        this.#emitError(`stt error${why ? `: ${why}` : ''}`);
        break;
      }
      default:
    }
  }

  #send(x: string | Uint8Array): void {
    if (this.#dead) return;
    if (this.#live) this.#ws.send(x);
    else {
      this.#queue.push(x);
      let ms = 0; // audio waiting for the start acknowledgement is bounded: the oldest goes first
      for (const q of this.#queue) if (typeof q !== 'string') ms += (q.length / 2 / this.o.sampleRateHz) * 1000;
      while (ms > MAX_QUEUED_MS) {
        const i = this.#queue.findIndex((q) => typeof q !== 'string');
        if (i < 0) break;
        const [d] = this.#queue.splice(i, 1);
        ms -= ((d as Uint8Array).length / 2 / this.o.sampleRateHz) * 1000;
        this.#pendingMs = Math.max(0, this.#pendingMs - ((d as Uint8Array).length / 2 / this.o.sampleRateHz) * 1000);
      }
    }
  }

  sendAudio(pcm: Uint8Array): void {
    if (!pcm.length || this.#dead) return;
    this.#pendingMs += (pcm.length / 2 / this.o.sampleRateHz) * 1000;
    this.#send(pcm);
  }

  commit(): boolean {
    if (this.#pendingMs < STT_MIN_COMMIT_MS) return false;
    this.#pendingMs = 0;
    this.#send(JSON.stringify({ type: 'commit' }));
    return true;
  }

  get pendingMs(): number {
    return this.#pendingMs;
  }

  interrupt(): void {
    this.#pendingMs = 0;
    this.#queue = this.#queue.filter((x) => typeof x === 'string'); // audio that never left is dropped
    this.#send(JSON.stringify({ action: 'interrupt' }));
  }

  onFinal(cb: (f: SttFinal) => void): void {
    this.#finals.push(cb);
  }
  onError(cb: (m: string) => void): void {
    this.#errors.push(cb);
  }
  close(): void {
    this.#closed = true;
    clearTimeout(this.#startTimer);
    try {
      this.#ws.close();
    } catch {
      /* already closed */
    }
  }
}
