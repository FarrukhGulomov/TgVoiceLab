import WebSocket from 'ws';
import type { RealtimeLink } from '../../modules/calls/audio/realtime-bridge.js';

/**
 * OpenAI Realtime over WebSocket.
 *
 * STATUS: written from memory of the public protocol; the OpenAI docs could NOT be reached from the build sandbox (see
 * docs/IMPLEMENTATION_STATUS.md). Nothing here is verified against the current documentation or a live session. Therefore:
 *  - the model name is NEVER hardcoded (OPENAI_REALTIME_MODEL is required);
 *  - two wire dialects are supported (`ga` and `beta`) and chosen by config;
 *  - every server `error` event is surfaced verbatim, so a wrong field name shows up as a readable message on the first live run.
 */
export type RealtimeDialect = 'ga' | 'beta';

export interface RealtimeOptions {
  apiKey: string;
  model: string;
  voice?: string | undefined;
  instructions: string;
  /** Optional input-transcription model (printed as `caller:` lines). Never defaulted: the name must come from configuration. */
  transcriptionModel?: string | undefined;
  dialect?: RealtimeDialect | undefined;
  sampleRateHz?: number | undefined;
  baseUrl?: string | undefined;
  /** Test seam. */
  socketFactory?: ((url: string, headers: Record<string, string>) => WebSocket) | undefined;
}

export function sessionUpdate(o: Pick<RealtimeOptions, 'voice' | 'instructions' | 'dialect' | 'sampleRateHz' | 'transcriptionModel'>): Record<string, unknown> {
  const rate = o.sampleRateHz ?? 24_000;
  if ((o.dialect ?? 'ga') === 'beta')
    return {
      type: 'session.update',
      session: {
        modalities: ['audio', 'text'],
        instructions: o.instructions,
        ...(o.voice ? { voice: o.voice } : {}),
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        ...(o.transcriptionModel ? { input_audio_transcription: { model: o.transcriptionModel } } : {}),
        turn_detection: { type: 'server_vad' },
      },
    };
  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      instructions: o.instructions,
      output_modalities: ['audio'],
      audio: {
        input: {
          format: { type: 'audio/pcm', rate },
          turn_detection: { type: 'server_vad' },
          ...(o.transcriptionModel ? { transcription: { model: o.transcriptionModel } } : {}),
        },
        output: { format: { type: 'audio/pcm', rate }, ...(o.voice ? { voice: o.voice } : {}) },
      },
    },
  };
}

export class OpenAiRealtimeLink implements RealtimeLink {
  readonly inputRateHz: number;
  readonly outputRateHz: number;
  #ws: WebSocket;
  #open = false;
  #queue: string[] = [];
  #audio: Array<(pcm: Uint8Array) => void> = [];
  #speech: Array<() => void> = [];
  #transcript: Array<(who: 'assistant' | 'caller', text: string) => void> = [];
  #errors: Array<(m: string) => void> = [];
  #responseStart: Array<() => void> = [];
  #activeResponse = false;
  #lastItemId: string | null = null;

  constructor(o: RealtimeOptions) {
    this.inputRateHz = this.outputRateHz = o.sampleRateHz ?? 24_000;
    const url = `${o.baseUrl ?? 'wss://api.openai.com/v1/realtime'}?model=${encodeURIComponent(o.model)}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${o.apiKey}` };
    if (o.dialect === 'beta') headers['OpenAI-Beta'] = 'realtime=v1';
    this.#ws = o.socketFactory ? o.socketFactory(url, headers) : new WebSocket(url, { headers });
    this.#ws.on('open', () => {
      this.#open = true;
      this.#send(sessionUpdate(o));
      for (const m of this.#queue) this.#ws.send(m);
      this.#queue = [];
    });
    this.#ws.on('message', (raw: WebSocket.RawData) => this.#onMessage(raw.toString()));
    this.#ws.on('error', (e: Error) => this.#emitError(`websocket: ${e.message}`));
    this.#ws.on('close', (code: number) => this.#emitError(`websocket closed (${code})`, true));
  }

  #emitError(m: string, quiet = false): void {
    if (quiet && this.#closed) return;
    for (const cb of this.#errors) cb(m);
  }
  #closed = false;

  #send(obj: Record<string, unknown>): void {
    const s = JSON.stringify(obj);
    if (this.#open) this.#ws.send(s);
    else this.#queue.push(s); // anything sent before the socket opens is delivered after session.update
  }

  #onMessage(raw: string): void {
    let e: { type?: string; delta?: string; transcript?: string; item_id?: string; error?: { message?: string; code?: string } };
    try {
      e = JSON.parse(raw) as typeof e;
    } catch {
      return;
    }
    switch (e.type) {
      case 'response.created':
        this.#activeResponse = true;
        for (const cb of this.#responseStart) cb();
        break;
      case 'response.done':
        this.#activeResponse = false;
        break;
      case 'response.output_audio.delta': // ga
      case 'response.audio.delta': // beta
        if (e.item_id) this.#lastItemId = e.item_id;
        if (e.delta) for (const cb of this.#audio) cb(new Uint8Array(Buffer.from(e.delta, 'base64')));
        break;
      case 'input_audio_buffer.speech_started':
        for (const cb of this.#speech) cb();
        break;
      case 'response.output_audio_transcript.done': // ga
      case 'response.audio_transcript.done': // beta
        if (e.transcript) for (const cb of this.#transcript) cb('assistant', e.transcript);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (e.transcript) for (const cb of this.#transcript) cb('caller', e.transcript);
        break;
      case 'error':
        // Cancelling when nothing is in flight is a race we lose harmlessly (the response just finished), not a fault.
        if (e.error?.code === 'response_cancel_not_active') break;
        this.#emitError(`${e.error?.code ?? 'error'}: ${e.error?.message ?? raw.slice(0, 200)}`);
        break;
      default:
    }
  }

  sendAudio(pcm: Uint8Array): void {
    if (!pcm.length) return;
    this.#send({ type: 'input_audio_buffer.append', audio: Buffer.from(pcm).toString('base64') });
  }
  respond(instructions?: string): void {
    this.#send({ type: 'response.create', ...(instructions ? { response: { instructions } } : {}) });
  }
  interrupt(playedMs: number): void {
    if (this.#activeResponse) this.#send({ type: 'response.cancel' });
    if (this.#lastItemId)
      this.#send({ type: 'conversation.item.truncate', item_id: this.#lastItemId, content_index: 0, audio_end_ms: Math.max(0, Math.round(playedMs)) });
    this.#lastItemId = null;
  }
  onResponseStart(cb: () => void): void {
    this.#responseStart.push(cb);
  }
  onAudio(cb: (pcm: Uint8Array) => void): void {
    this.#audio.push(cb);
  }
  onSpeechStarted(cb: () => void): void {
    this.#speech.push(cb);
  }
  onTranscript(cb: (who: 'assistant' | 'caller', text: string) => void): void {
    this.#transcript.push(cb);
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
