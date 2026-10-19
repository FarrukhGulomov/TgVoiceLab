import WebSocket from 'ws';
import type { TtsLanguage } from './tts.js';

/**
 * VoiceLab streaming speech synthesis (docs.voicelab.uz/api/tts#realtime-speech), the contract as confirmed by the vendor's documentation:
 *   wss://api.voicelab.uz/v1/tts/stream, handshake header `xvl-api-key` (key permission tts:realtime).
 *   1. wait for {"event":"ready"}   2. send ONE json request {text, language, voice_id, speed}   (one request per connection, text <= 8 KiB, speed 0.5-2.0)
 *   3. audio arrives as binary messages: pcm_s16le, 24000 Hz, mono, no WAV header   4. {"event":"done"} ends it, {"event":"error"} fails it
 *   {"action":"interrupt"} stops a synthesis (answered with {"event":"interrupted"}).
 * The documentation shows no way to append text to a running request, so every sentence gets its own connection; nothing beyond the
 * documented messages is sent. The model is not selectable on this endpoint (no `model_id` in the contract), so it is never sent.
 * NOT live verified from the build sandbox (voicelab.uz is unreachable there).
 */
export const TTS_STREAM_RATE_HZ = 24_000;
export const TTS_STREAM_MAX_TEXT_BYTES = 8 * 1024;

export interface StreamingSynthesizer {
  /**
   * Synthesises one piece of text and hands every audio chunk (s16le mono, 24 kHz, always an even number of bytes) to `onChunk` the moment it
   * arrives. Resolves when the server says it is done; rejects on an error event, a lost connection, a timeout or `signal`. Nothing is retried.
   */
  synthesizeStream(text: string, language: TtsLanguage, signal: AbortSignal | undefined, onChunk: (pcm: Uint8Array) => void): Promise<void>;
}

export interface VoiceLabTtsStreamOptions {
  apiKey: string;
  voiceId: string;
  /** Default wss://api.voicelab.uz/v1/tts/stream */
  url?: string | undefined;
  speed?: number | undefined;
  /** Waiting for `ready` plus the first audio chunk. */
  firstAudioTimeoutMs?: number | undefined;
  /** Longest silence between two chunks once audio started. */
  chunkTimeoutMs?: number | undefined;
  /** Connections open at the same time; further sentences wait (their order is kept by the caller). */
  maxConcurrent?: number | undefined;
  /** Test seam. */
  socketFactory?: ((url: string, headers: Record<string, string>) => WebSocket) | undefined;
}

export class VoiceLabTtsStream implements StreamingSynthesizer {
  #active = 0;
  #waiting: Array<() => void> = [];

  constructor(private readonly o: VoiceLabTtsStreamOptions) {}

  #release(): void {
    this.#active--;
    this.#waiting.shift()?.();
  }

  #scrub(s: string): string {
    return s.split(this.o.apiKey).join('***').slice(0, 300);
  }

  synthesizeStream(text: string, language: TtsLanguage, signal: AbortSignal | undefined, onChunk: (pcm: Uint8Array) => void): Promise<void> {
    if (Buffer.byteLength(text) > TTS_STREAM_MAX_TEXT_BYTES) return Promise.reject(new Error('voicelab tts stream: text is longer than 8 KiB'));
    if (signal?.aborted) return Promise.reject(new Error('aborted'));
    const go = (): Promise<void> => {
      this.#active++;
      return this.#run(text, language, signal, onChunk).finally(() => this.#release());
    };
    if (this.#active < (this.o.maxConcurrent ?? 3)) return go(); // the connection opens at once
    return new Promise<void>((resolve, reject) => {
      const start = (): void => {
        signal?.removeEventListener('abort', onAbort);
        go().then(resolve, reject);
      };
      const onAbort = (): void => {
        this.#waiting = this.#waiting.filter((w) => w !== start);
        reject(new Error('aborted'));
      };
      this.#waiting.push(start);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  #run(text: string, language: TtsLanguage, signal: AbortSignal | undefined, onChunk: (pcm: Uint8Array) => void): Promise<void> {
    const url = this.o.url ?? 'wss://api.voicelab.uz/v1/tts/stream';
    const headers = { 'xvl-api-key': this.o.apiKey };
    const speed = Math.min(2, Math.max(0.5, this.o.speed ?? 1));
    return new Promise<void>((resolve, reject) => {
      const ws = this.o.socketFactory ? this.o.socketFactory(url, headers) : new WebSocket(url, { headers });
      let settled = false;
      let gotAudio = false;
      let carry: number | undefined; // a chunk may end in the middle of a 16-bit sample
      let timer: NodeJS.Timeout | undefined;

      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        try {
          ws.close();
        } catch {
          /* already closed */
        }
        if (err) reject(err);
        else resolve();
      };
      const arm = (ms: number, what: string): void => {
        clearTimeout(timer);
        timer = setTimeout(() => finish(new Error(`voicelab tts stream: no ${what} within ${ms} ms`)), ms);
      };
      const onAbort = (): void => {
        if (!settled) {
          try {
            ws.send(JSON.stringify({ action: 'interrupt' })); // stop the synthesis on the server too (no more credits spent)
          } catch {
            /* not open yet */
          }
        }
        finish(new Error('aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      arm(this.o.firstAudioTimeoutMs ?? 8_000, 'audio');

      ws.on('message', (raw: WebSocket.RawData, isBinary?: boolean) => {
        if (settled) return;
        if (isBinary) {
          let b = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
          if (carry !== undefined) b = Buffer.concat([Buffer.from([carry]), b]);
          carry = b.length % 2 ? b[b.length - 1] : undefined;
          const even = b.length - (b.length % 2);
          if (!even) return;
          gotAudio = true;
          arm(this.o.chunkTimeoutMs ?? 5_000, 'audio chunk');
          onChunk(new Uint8Array(b.buffer, b.byteOffset, even));
          return;
        }
        let m: { event?: unknown; code?: unknown; message?: unknown; error?: unknown };
        try {
          m = JSON.parse(raw.toString()) as typeof m;
        } catch {
          return;
        }
        switch (m.event) {
          case 'ready':
            // exactly one request per connection
            ws.send(JSON.stringify({ text, language, voice_id: this.o.voiceId, speed }));
            break;
          case 'done':
            finish();
            break;
          case 'interrupted':
            finish(new Error('interrupted'));
            break;
          case 'error': {
            const why = [m.code, m.message ?? m.error].filter((x) => typeof x === 'string').join(': ');
            finish(new Error(this.#scrub(`voicelab tts stream error${why ? `: ${why}` : ''}`)));
            break;
          }
          default:
        }
      });
      ws.on('error', (e: Error) => finish(new Error(this.#scrub(`voicelab tts stream: ${e.message}`))));
      ws.on('close', (code: number) => {
        if (!settled) finish(new Error(`voicelab tts stream closed (${code}) ${gotAudio ? 'in the middle of the audio' : 'before any audio'}`));
      });
    });
  }
}
