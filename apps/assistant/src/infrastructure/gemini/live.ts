import WebSocket from 'ws';
import type { RealtimeLink, ToolCall, ToolDeclaration } from '../../modules/calls/audio/realtime-bridge.js';

/**
 * Google Gemini Live (BidiGenerateContent over WebSocket) as an AI voice session.
 *
 * STATUS: written from memory of the public protocol; Google's docs could NOT be reached from the build sandbox and this has never
 * run against the real service. Therefore the model name is NEVER hardcoded (GEMINI_LIVE_MODEL), the one message shape that differs
 * between model generations (how plain text is sent) is switchable, and every failure — server close code + reason, unexpected audio
 * format — is surfaced verbatim so a wrong field shows up as a readable message on the first live run.
 *
 * Wire facts relied on: setup message first, wait for `setupComplete`; audio in as 16 kHz s16le PCM, audio out as 24 kHz s16le PCM;
 * the server detects speech and reports `interrupted` itself (nothing to cancel or truncate client-side).
 * Privacy: free-tier API content may be used by the provider to improve its products. Do not use a free key for contact calls or real owner data.
 */
export interface GeminiLiveOptions {
  apiKey: string;
  model: string;
  voice?: string | undefined;
  instructions: string;
  /** Let the model use Google Search for facts it does not know (tool `googleSearch`). Off unless configured. */
  googleSearch?: boolean | undefined;
  /** BCP-47 language hint for the spoken output (e.g. `uz-UZ`). Not defaulted: support differs by model; a rejected value shows up as a server error. */
  languageCode?: string | undefined;
  tools?: ToolDeclaration[] | undefined;
  /** Diagnostics: one line per server message (structure only — never audio data, never the API key). */
  debug?: ((line: string) => void) | undefined;
  /**
   * Another voice speaks, the model only decides. `true`: the model answers in TEXT (needs a Live model that supports TEXT output; native-audio
   * models are AUDIO-only and close with 1007). `'transcript'`: the model still answers in audio, which is DROPPED, and the transcript of what it
   * said is streamed through `onText` instead (works with native-audio models).
   */
  textOutput?: boolean | 'transcript' | undefined;
  /** How long to wait for `setupComplete` before reporting that the setup was rejected or ignored. */
  setupTimeoutMs?: number | undefined;
  /** How a plain-text turn (the greeting) is sent. `realtime` = realtimeInput.text (newer), `client_content` = clientContent turn (older). */
  textMode?: 'realtime' | 'client_content' | undefined;
  baseUrl?: string | undefined;
  /** Test seam. */
  socketFactory?: ((url: string) => WebSocket) | undefined;
}

export const GEMINI_INPUT_RATE = 16_000;
export const GEMINI_OUTPUT_RATE = 24_000;
const DEFAULT_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export function geminiSetup(
  o: Pick<GeminiLiveOptions, 'model' | 'voice' | 'instructions' | 'googleSearch' | 'languageCode' | 'tools' | 'textOutput'>,
): Record<string, unknown> {
  return {
    setup: {
      model: o.model.startsWith('models/') ? o.model : `models/${o.model}`,
      generationConfig: {
        responseModalities: [o.textOutput === true ? 'TEXT' : 'AUDIO'],
        ...(o.textOutput !== true && (o.voice || o.languageCode)
          ? {
              speechConfig: {
                ...(o.voice ? { voiceConfig: { prebuiltVoiceConfig: { voiceName: o.voice } } } : {}),
                ...(o.languageCode ? { languageCode: o.languageCode } : {}),
              },
            }
          : {}),
      },
      ...(o.googleSearch || o.tools?.length
        ? {
            tools: [
              ...(o.googleSearch ? [{ googleSearch: {} }] : []),
              ...(o.tools?.length
                ? [{ functionDeclarations: o.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }]
                : []),
            ],
          }
        : {}),
      systemInstruction: { parts: [{ text: o.instructions }] },
      inputAudioTranscription: {},
      ...(o.textOutput === true ? {} : { outputAudioTranscription: {} }),
    },
  };
}

/** A one-line structural summary of a server message: keys and audio part counts only. */
export function describe(m: ServerMessage): string {
  const keys = Object.keys(m);
  const sc = m.serverContent;
  if (!sc) return `msg ${keys.join(',') || '(empty)'}${m.error ? ` error=${JSON.stringify(m.error).slice(0, 200)}` : ''}`;
  const parts = sc.modelTurn?.parts ?? [];
  const flags = [
    sc.interrupted && 'interrupted',
    sc.turnComplete && 'turnComplete',
    sc.inputTranscription && 'inputTranscription',
    sc.outputTranscription && 'outputTranscription',
  ].filter(Boolean);
  return `serverContent audioParts=${parts.filter((p) => p.inlineData).length}${flags.length ? ` ${flags.join(',')}` : ''}`;
}

interface ServerMessage {
  setupComplete?: unknown;
  toolCall?: { functionCalls?: Array<{ id?: string; name?: string; args?: Record<string, unknown> }> };
  serverContent?: {
    modelTurn?: { parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }> };
    interrupted?: boolean;
    turnComplete?: boolean;
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
  };
  error?: { message?: string; code?: number | string };
}

export class GeminiLiveLink implements RealtimeLink {
  readonly inputRateHz = GEMINI_INPUT_RATE;
  readonly outputRateHz = GEMINI_OUTPUT_RATE;
  #ws: WebSocket;
  #ready = false;
  #queue: string[] = [];
  #closed = false;
  #heard = '';
  #said = '';
  #audio: Array<(pcm: Uint8Array) => void> = [];
  #speech: Array<() => void> = [];
  #responseStart: Array<() => void> = [];
  #transcript: Array<(who: 'assistant' | 'caller', text: string) => void> = [];
  #errors: Array<(m: string) => void> = [];
  #speaking = false;
  #toolCalls: Array<(c: ToolCall) => void> = [];
  #text: Array<(delta: string, done: boolean) => void> = [];
  readonly #textMode: 'realtime' | 'client_content';
  readonly #viaTranscript: boolean;
  readonly #debug: ((line: string) => void) | undefined;
  #setupTimer: NodeJS.Timeout | undefined;

  constructor(o: GeminiLiveOptions) {
    this.#textMode = o.textMode ?? 'realtime';
    this.#viaTranscript = o.textOutput === 'transcript';
    this.#debug = o.debug;
    const url = `${o.baseUrl ?? DEFAULT_URL}?key=${encodeURIComponent(o.apiKey)}`;
    this.#ws = o.socketFactory ? o.socketFactory(url) : new WebSocket(url);
    this.#ws.on('open', () => {
      this.#debug?.('socket open; setup sent');
      this.#ws.send(JSON.stringify(geminiSetup(o)));
      const ms = o.setupTimeoutMs ?? 8000;
      this.#setupTimer = setTimeout(() => {
        if (!this.#ready && !this.#closed)
          this.#emitError(
            `no setupComplete within ${ms / 1000} s: the setup was rejected or ignored (try without GEMINI_GOOGLE_SEARCH / GEMINI_LANGUAGE_CODE)`,
          );
      }, ms);
    });
    this.#ws.on('message', (raw: WebSocket.RawData) => this.#onMessage(raw.toString()));
    this.#ws.on('error', (e: Error) => this.#emitError(`websocket: ${e.message.replace(o.apiKey, '***')}`));
    this.#ws.on('close', (code: number, reason: Buffer) => {
      clearTimeout(this.#setupTimer);
      this.#debug?.(`socket closed (${code})`);
      if (!this.#closed) this.#emitError(`websocket closed (${code}) ${reason.toString().replace(o.apiKey, '***').slice(0, 300)}`.trim());
    });
  }

  #emitError(m: string): void {
    for (const cb of this.#errors) cb(m);
  }
  #send(obj: Record<string, unknown>): void {
    const s = JSON.stringify(obj);
    if (this.#ready) this.#ws.send(s);
    else this.#queue.push(s); // anything sent before setupComplete is delivered right after it
  }
  #flushTranscripts(): void {
    if (this.#heard.trim()) for (const cb of this.#transcript) cb('caller', this.#heard.trim());
    if (this.#said.trim()) for (const cb of this.#transcript) cb('assistant', this.#said.trim());
    this.#heard = '';
    this.#said = '';
  }

  #onMessage(raw: string): void {
    let m: ServerMessage;
    try {
      m = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    this.#debug?.(describe(m));
    if (m.setupComplete !== undefined) {
      clearTimeout(this.#setupTimer);
      this.#ready = true;
      for (const q of this.#queue) this.#ws.send(q);
      this.#queue = [];
      return;
    }
    if (m.error) {
      this.#emitError(`${m.error.code ?? 'error'}: ${m.error.message ?? raw.slice(0, 200)}`);
      return;
    }
    for (const fc of m.toolCall?.functionCalls ?? [])
      if (fc.name) for (const cb of this.#toolCalls) cb({ id: fc.id ?? fc.name, name: fc.name, args: fc.args ?? {} });
    const sc = m.serverContent;
    if (!sc) return;
    if (sc.inputTranscription?.text) this.#heard += sc.inputTranscription.text;
    if (sc.outputTranscription?.text) {
      this.#said += sc.outputTranscription.text;
      if (this.#viaTranscript) {
        if (!this.#speaking) {
          this.#speaking = true;
          for (const cb of this.#responseStart) cb();
        }
        for (const cb of this.#text) cb(sc.outputTranscription.text, false);
      }
    }
    for (const part of sc.modelTurn?.parts ?? []) {
      if (part.text) {
        if (!this.#speaking) {
          this.#speaking = true;
          for (const cb of this.#responseStart) cb();
        }
        for (const cb of this.#text) cb(part.text, false);
        continue;
      }
      const d = part.inlineData;
      if (!d?.data || this.#viaTranscript) continue; // the model's own voice is not used: another voice speaks its transcript
      const rate = /rate=(\d+)/.exec(d.mimeType ?? '')?.[1];
      if (rate && Number(rate) !== GEMINI_OUTPUT_RATE) {
        this.#emitError(`unexpected audio format ${d.mimeType} (expected ${GEMINI_OUTPUT_RATE} Hz PCM)`);
        continue;
      }
      if (!this.#speaking) {
        this.#speaking = true;
        for (const cb of this.#responseStart) cb();
      }
      for (const cb of this.#audio) cb(new Uint8Array(Buffer.from(d.data, 'base64')));
    }
    if (sc.interrupted) {
      this.#speaking = false;
      for (const cb of this.#speech) cb();
      this.#flushTranscripts();
    }
    if (sc.turnComplete) {
      this.#speaking = false;
      for (const cb of this.#text) cb('', true);
      this.#flushTranscripts();
    }
  }

  sendAudio(pcm: Uint8Array): void {
    if (!pcm.length) return;
    this.#send({ realtimeInput: { audio: { data: Buffer.from(pcm).toString('base64'), mimeType: `audio/pcm;rate=${GEMINI_INPUT_RATE}` } } });
  }
  respond(instructions?: string): void {
    if (!instructions) return;
    if (this.#textMode === 'client_content') this.#send({ clientContent: { turns: [{ role: 'user', parts: [{ text: instructions }] }], turnComplete: true } });
    else this.#send({ realtimeInput: { text: instructions } });
  }
  onToolCall(cb: (c: ToolCall) => void): void {
    this.#toolCalls.push(cb);
  }
  /** Gemini continues generating after a tool response by itself; `respond: false` cannot suppress that (the caller hangs up instead). */
  sendToolResult(call: ToolCall, result: unknown): void {
    this.#send({ toolResponse: { functionResponses: [{ id: call.id, name: call.name, response: { output: result } }] } });
  }
  /** The server already stopped generating and dropped unplayed audio when it reported `interrupted`: nothing to do client-side. */
  interrupt(): void {}
  onText(cb: (delta: string, done: boolean) => void): void {
    this.#text.push(cb);
  }
  onAudio(cb: (pcm: Uint8Array) => void): void {
    this.#audio.push(cb);
  }
  onSpeechStarted(cb: () => void): void {
    this.#speech.push(cb);
  }
  onResponseStart(cb: () => void): void {
    this.#responseStart.push(cb);
  }
  onTranscript(cb: (who: 'assistant' | 'caller', text: string) => void): void {
    this.#transcript.push(cb);
  }
  onError(cb: (m: string) => void): void {
    this.#errors.push(cb);
  }
  close(): void {
    this.#closed = true;
    clearTimeout(this.#setupTimer);
    try {
      this.#ws.close();
    } catch {
      /* already closed */
    }
  }
}
