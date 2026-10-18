import { randomUUID } from 'node:crypto';

/**
 * VoiceLab (voicelab.uz) text-to-speech over REST: `POST /v1/tts` {text, language, voice_id, speed?} answers with a 24 kHz mono WAV.
 * Source: the vendor's public MCP server (github.com/voicelab-uz/mcp). NOT live verified against the service from the build sandbox
 * (voicelab.uz was unreachable there). The live API answered an unknown field with the allowed list: text, language, voice_id, speed, use_cache, model_id. `model_id` is sent only when configured
 * (the web studio offers "Lison v1"), so a wrong id shows up as a readable provider error instead of a silent guess.
 */
export interface VoiceLabTtsOptions {
  apiKey: string;
  voiceId: string;
  baseUrl?: string | undefined;
  model?: string | undefined;
  speed?: number | undefined;
  timeoutMs?: number | undefined;
  /** Test seam. */
  fetchImpl?: typeof fetch | undefined;
}

export type TtsLanguage = 'uz' | 'ru' | 'en';

export interface Synthesized {
  /** s16le mono samples */
  pcm: Uint8Array;
  rateHz: number;
}

export interface Synthesizer {
  synthesize(text: string, language: TtsLanguage, signal?: AbortSignal): Promise<Synthesized>;
}

/** Reads a RIFF/WAVE file: finds the `fmt ` and `data` chunks (a header is not always exactly 44 bytes). */
export function parseWav(b: Uint8Array): Synthesized {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = (o: number) => String.fromCharCode(...b.subarray(o, o + 4));
  if (b.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let rate = 0;
  let bits = 0;
  let channels = 0;
  let o = 12;
  while (o + 8 <= b.length) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    if (id === 'fmt ') {
      channels = v.getUint16(o + 10, true);
      rate = v.getUint32(o + 12, true);
      bits = v.getUint16(o + 22, true);
    } else if (id === 'data') {
      if (bits !== 16 || channels !== 1 || !rate) throw new Error(`unsupported WAV (need 16-bit mono, got ${bits}-bit ${channels} ch)`);
      const end = size === 0 || o + 8 + size > b.length ? b.length : o + 8 + size; // streamed WAVs may carry a bogus size
      return { pcm: b.subarray(o + 8, end - ((end - o - 8) % 2)), rateHz: rate };
    }
    o += 8 + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}

export class VoiceLabTts implements Synthesizer {
  readonly #base: string;
  constructor(private readonly o: VoiceLabTtsOptions) {
    this.#base = (o.baseUrl ?? 'https://api.voicelab.uz').replace(/\/+$/, '');
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.o.apiKey}`, ...extra };
  }

  async synthesize(text: string, language: TtsLanguage, signal?: AbortSignal): Promise<Synthesized> {
    const f = this.o.fetchImpl ?? fetch;
    const timeout = AbortSignal.timeout(this.o.timeoutMs ?? 15_000);
    const res = await f(`${this.#base}/v1/tts`, {
      method: 'POST',
      headers: this.#headers({ 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }),
      body: JSON.stringify({
        text: text.slice(0, 5000),
        language,
        voice_id: this.o.voiceId,
        ...(this.o.speed ? { speed: this.o.speed } : {}),
        ...(this.o.model ? { model_id: this.o.model } : {}),
      }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`voicelab tts HTTP ${res.status}${body ? `: ${body}` : ''}`);
    }
    return parseWav(new Uint8Array(await res.arrayBuffer()));
  }

  /** Voices of an account (for `pnpm voicelab:check`): finds the id of a voice by name. */
  async listVoices(language?: string): Promise<Array<{ id: string; display_name: string; description?: string; language: string }>> {
    const f = this.o.fetchImpl ?? fetch;
    const url = `${this.#base}/v1/voices${language ? `?language=${encodeURIComponent(language)}` : ''}`;
    const res = await f(url, { headers: this.#headers(), signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000) });
    if (!res.ok) throw new Error(`voicelab voices HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
    const j = (await res.json()) as { data?: Array<{ id: string; display_name: string; description?: string; language: string }> };
    return j.data ?? [];
  }
}
