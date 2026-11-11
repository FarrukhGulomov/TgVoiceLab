import { AudioFormat, CommitStrategy, RealtimeEvents, type ElevenLabsClient, type RealtimeConnection } from '@elevenlabs/elevenlabs-js';
import type { SttFinal, SttStream } from '../voicelab/stt-stream.js';
import { STT_MIN_COMMIT_MS } from '../voicelab/stt-stream.js';

/**
 * ElevenLabs live speech recognition (Scribe realtime) through the official SDK. The call's own voice-activity detector decides where an
 * utterance ends, so the session runs with `commitStrategy: manual`: audio goes out as `input_audio_chunk`, `commit()` ends the utterance
 * and the `committed_transcript` that follows is the final text. Audio is 16 kHz PCM16 mono, the rate the ears deliver.
 * NOT live verified from the build sandbox (elevenlabs.io is unreachable there).
 */
export interface ElevenLabsSttOptions {
  client: Pick<ElevenLabsClient, 'speechToText'>;
  /** e.g. `scribe_v2_realtime`; never defaulted. */
  model: string;
  language: string;
  sampleRateHz: number;
  /** Test seam / diagnostics: event names only, never audio or text. */
  log?: ((line: string) => void) | undefined;
  maxReconnects?: number | undefined;
  connectTimeoutMs?: number | undefined;
  /** Bias the recogniser towards these words (names, product terms); at most 50 of up to 20 characters. */
  keyterms?: string[] | undefined;
}

const MAX_QUEUED_MS = 5_000;
const ERROR_REPEAT_MS = 5_000;
const FINAL_TIMEOUT_MS = 8_000;

export class ElevenLabsSttStream implements SttStream {
  #conn: RealtimeConnection | undefined;
  #generation = 0; // bumped on every (re)connection: events of an older socket are ignored
  #ready = false;
  #closed = false;
  #connecting = false;
  #reconnects = 0;
  #queue: Array<string | 'commit'> = []; // base64 audio chunks and commit markers waiting for the session
  #pendingMs = 0;
  #expecting = 0; // commits sent whose transcript has not come back yet
  #ignore = 0; // transcripts to drop (their utterance was cancelled by interrupt)
  #flightTimer: ReturnType<typeof setTimeout> | undefined;
  #finals: Array<(f: SttFinal) => void> = [];
  #errors: Array<(m: string) => void> = [];
  #lastError = { msg: '', at: 0, n: 0 };
  #seen = new Set<string>();

  constructor(private readonly o: ElevenLabsSttOptions) {
    void this.#connect();
  }

  get pendingMs(): number {
    return this.#pendingMs;
  }

  #emitError(m: string): void {
    const msg = m.slice(0, 300);
    const now = Date.now();
    if (msg === this.#lastError.msg && now - this.#lastError.at < ERROR_REPEAT_MS) {
      this.#lastError.n++;
      return;
    }
    const more = this.#lastError.n > 0 ? ` (previous error repeated ${this.#lastError.n}x)` : '';
    this.#lastError = { msg, at: now, n: 0 };
    for (const cb of this.#errors) cb(msg + more);
  }

  async #connect(): Promise<void> {
    if (this.#closed || this.#connecting) return;
    this.#connecting = true;
    const generation = ++this.#generation;
    this.#ready = false;
    try {
      const opening = this.o.client.speechToText.realtime.connect({
        modelId: this.o.model,
        audioFormat: AudioFormat.PCM_16000,
        sampleRate: this.o.sampleRateHz,
        languageCode: this.o.language,
        commitStrategy: CommitStrategy.MANUAL,
        ...(this.o.keyterms?.length ? { keyterms: this.o.keyterms.slice(0, 50).map((k) => k.slice(0, 20)) } : {}),
      });
      // A connection that never opens must not leave the call deaf and silent: it counts as a failed attempt.
      let timer: NodeJS.Timeout | undefined;
      let gaveUp = false;
      void opening.then(
        (late) => {
          if (gaveUp) late.close(); // a connection that arrives after we gave up is closed, never left open
        },
        () => undefined,
      );
      const conn = await Promise.race([
        opening,
        new Promise<never>(
          (_, rej) =>
            (timer = setTimeout(() => {
              gaveUp = true;
              rej(new Error('no connection within 8 s'));
            }, this.o.connectTimeoutMs ?? 8_000)),
        ),
      ]).finally(() => clearTimeout(timer));
      if (this.#closed || generation !== this.#generation) {
        conn.close();
        return;
      }
      this.#conn = conn;
      const live = (): boolean => generation === this.#generation && !this.#closed;
      const seen = (kind: string): void => {
        if (!this.#seen.has(kind)) {
          this.#seen.add(kind);
          this.o.log?.(`stt event: ${kind}`);
        }
      };
      conn.on(RealtimeEvents.SESSION_STARTED, () => {
        if (!live()) return;
        seen('session_started');
        this.#ready = true;
        this.#reconnects = 0;
        this.#pump();
      });
      conn.on(RealtimeEvents.COMMITTED_TRANSCRIPT, (d) => {
        if (!live()) return;
        seen('committed_transcript');
        if (this.#expecting > 0) this.#expecting--;
        clearTimeout(this.#flightTimer);
        if (this.#ignore > 0) {
          this.#ignore--; // belongs to an utterance that was cancelled
        } else if (typeof d.text === 'string') for (const cb of this.#finals) cb({ text: d.text, language: this.o.language });
        if (this.#expecting > 0) this.#armFlight();
      });
      const fail = (kind: string, fatal: boolean) => (d: { error?: string } | Error | undefined) => {
        if (!live()) return;
        seen(kind);
        const why = d && 'error' in d && d.error ? d.error : d instanceof Error ? d.message : '';
        this.#emitError(`stt ${kind}${why ? `: ${why}` : ''}`);
        if (kind === 'insufficient_audio_activity' || kind === 'commit_throttled') {
          // a commit with nothing (or too little) in it gets no transcript
          if (this.#expecting > 0) this.#expecting--;
          return;
        }
        if (fatal) this.#giveUp(`stt ${kind}${why ? `: ${why}` : ''}`);
      };
      conn.on(RealtimeEvents.ERROR, fail('error', false));
      conn.on(RealtimeEvents.INPUT_ERROR, fail('input_error', false));
      conn.on(RealtimeEvents.TRANSCRIBER_ERROR, fail('transcriber_error', false));
      conn.on(RealtimeEvents.COMMIT_THROTTLED, fail('commit_throttled', false));
      conn.on(RealtimeEvents.INSUFFICIENT_AUDIO_ACTIVITY, fail('insufficient_audio_activity', false));
      conn.on(RealtimeEvents.CHUNK_SIZE_EXCEEDED, fail('chunk_size_exceeded', false));
      conn.on(RealtimeEvents.AUTH_ERROR, fail('auth_error', true));
      conn.on(RealtimeEvents.QUOTA_EXCEEDED, fail('quota_exceeded', true));
      conn.on(RealtimeEvents.UNACCEPTED_TERMS_ERROR, fail('unaccepted_terms', true));
      conn.on(RealtimeEvents.INVALID_REQUEST, fail('invalid_request', true));
      conn.on(RealtimeEvents.RATE_LIMITED, fail('rate_limited', true));
      conn.on(RealtimeEvents.RESOURCE_EXHAUSTED, fail('resource_exhausted', true));
      conn.on(RealtimeEvents.SESSION_TIME_LIMIT_EXCEEDED, () => {
        if (live()) this.#reopen('session time limit');
      });
      conn.on(RealtimeEvents.CLOSE, () => {
        if (live()) this.#reopen('closed');
      });
    } catch (e) {
      if (generation === this.#generation && !this.#closed) {
        this.#emitError(`stt connect failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
        this.#reopen('connect failed');
      }
    } finally {
      this.#connecting = false;
    }
  }

  /** Same wording the call bridge treats as "the recogniser is gone for good" (the AI would hear nothing). */
  #giveUp(why: string): void {
    this.#closed = true;
    clearTimeout(this.#flightTimer);
    this.#conn?.close();
    this.#emitError(`stt websocket closed (${why})`);
  }

  #reopen(why: string): void {
    this.#ready = false;
    this.#queue = [];
    this.#pendingMs = 0;
    this.#expecting = 0;
    this.#ignore = 0;
    clearTimeout(this.#flightTimer);
    if (this.#reconnects >= (this.o.maxReconnects ?? 2)) return this.#giveUp(why);
    this.#reconnects++;
    setTimeout(() => void this.#connect(), 200 * this.#reconnects).unref?.();
  }

  #armFlight(): void {
    clearTimeout(this.#flightTimer);
    this.#flightTimer = setTimeout(() => {
      this.#emitError('stt: no result came back in time');
      this.#expecting = 0;
    }, FINAL_TIMEOUT_MS);
  }

  #bound(): void {
    const ms = (b64: string) => ((b64.length * 3) / 4 / 2 / this.o.sampleRateHz) * 1000;
    let total = 0;
    for (const q of this.#queue) if (q !== 'commit') total += ms(q);
    while (total > MAX_QUEUED_MS) {
      const i = this.#queue.findIndex((q) => q !== 'commit');
      if (i < 0) break;
      const dropped = this.#queue.splice(i, 1)[0] as string;
      total -= ms(dropped);
      this.#pendingMs = Math.max(0, this.#pendingMs - ms(dropped));
    }
  }

  #pump(): void {
    if (!this.#ready || !this.#conn) return;
    while (this.#queue.length) {
      const x = this.#queue.shift()!;
      try {
        if (x === 'commit') {
          this.#conn.commit();
          this.#expecting++;
          this.#armFlight();
        } else this.#conn.send({ audioBase64: x, sampleRate: this.o.sampleRateHz });
      } catch (e) {
        this.#emitError(`stt send failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
        return;
      }
    }
  }

  sendAudio(pcm: Uint8Array): void {
    if (!pcm.length || this.#closed) return;
    this.#pendingMs += (pcm.length / 2 / this.o.sampleRateHz) * 1000;
    this.#queue.push(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64'));
    this.#bound();
    this.#pump();
  }

  commit(): boolean {
    if (this.#closed || this.#pendingMs < STT_MIN_COMMIT_MS) return false;
    this.#pendingMs = 0;
    this.#queue.push('commit');
    this.#pump();
    return true;
  }

  /** There is no cancel message in the protocol: what was already sent is committed and its transcript is dropped when it arrives. */
  interrupt(): void {
    const unsent = this.#queue.some((q) => q !== 'commit');
    this.#queue = [];
    const sentSomething = this.#pendingMs > 0 && !unsent;
    this.#pendingMs = 0;
    if (sentSomething && this.#ready && this.#conn) {
      try {
        this.#conn.commit();
        this.#expecting++;
        this.#ignore++;
        this.#armFlight();
      } catch {
        /* socket gone */
      }
    }
  }

  onFinal(cb: (f: SttFinal) => void): void {
    this.#finals.push(cb);
  }
  onError(cb: (m: string) => void): void {
    this.#errors.push(cb);
  }
  close(): void {
    this.#closed = true;
    this.#generation++;
    clearTimeout(this.#flightTimer);
    try {
      this.#conn?.close();
    } catch {
      /* already closed */
    }
  }
}
