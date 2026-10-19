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
}

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
  #ready = false;
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
    for (const cb of this.#errors) cb(this.#scrub(m));
  }

  #connect(): void {
    const headers = { 'xvl-api-key': this.o.apiKey };
    const ws = this.o.socketFactory ? this.o.socketFactory(this.o.url, headers) : new WebSocket(this.o.url, { headers });
    this.#ws = ws;
    this.#ready = false;
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
    switch (m.event ?? m.type) {
      case 'ready':
        this.#ready = true;
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
        for (const q of this.#queue) this.#ws.send(q);
        this.#queue = [];
        break;
      case 'final':
        if (typeof m.text === 'string')
          for (const cb of this.#finals) cb({ text: m.text, ...(typeof m.language === 'string' ? { language: m.language } : {}) });
        break;
      case 'error': {
        const why = [m.code, m.message ?? m.error].filter((x) => typeof x === 'string').join(': ');
        this.#emitError(`stt error${why ? `: ${why}` : ''}`);
        break;
      }
      default:
    }
  }

  #send(x: string | Uint8Array): void {
    if (this.#ready) this.#ws.send(x);
    else this.#queue.push(x);
  }

  sendAudio(pcm: Uint8Array): void {
    if (!pcm.length) return;
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
    try {
      this.#ws.close();
    } catch {
      /* already closed */
    }
  }
}
