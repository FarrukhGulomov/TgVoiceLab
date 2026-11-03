import type { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import type { Synthesized, Synthesizer, TtsLanguage } from '../voicelab/tts.js';
import type { StreamingSynthesizer } from '../voicelab/tts-stream.js';

/**
 * ElevenLabs text-to-speech through the official SDK (`textToSpeech.stream`: HTTP, chunked body). Audio is requested as raw `pcm_24000`
 * (16-bit little-endian mono, no header), the format the call pipeline already speaks, so nothing is decoded here. The model is never
 * defaulted: whether it speaks Uzbek is the account owner's call (`ELEVENLABS_TTS_MODEL`). NOT live verified from the build sandbox
 * (elevenlabs.io is unreachable there); the request shape follows the SDK's own types.
 */
export const ELEVENLABS_PCM_RATE_HZ = 24_000;
const MAX_TEXT_CHARS = 5000;

export interface ElevenLabsTtsOptions {
  client: Pick<ElevenLabsClient, 'textToSpeech'>;
  voiceId: string;
  model: string;
  /** ISO-639-1 hint; ignored by models that do not support it. Per request the detected language of the text wins when set below. */
  languageCode?: string | undefined;
  /** 0.7-1.2 (the API's own range). */
  speed?: number | undefined;
  stability?: number | undefined;
  /** Time to the first byte. */
  firstByteTimeoutMs?: number | undefined;
  /** Longest silence between two chunks once audio started. */
  chunkTimeoutMs?: number | undefined;
}

const request = (o: ElevenLabsTtsOptions, text: string, language: TtsLanguage) => ({
  text: text.slice(0, MAX_TEXT_CHARS),
  modelId: o.model,
  outputFormat: 'pcm_24000' as const,
  languageCode: o.languageCode ?? language,
  ...(o.speed !== undefined || o.stability !== undefined
    ? { voiceSettings: { ...(o.speed !== undefined ? { speed: o.speed } : {}), ...(o.stability !== undefined ? { stability: o.stability } : {}) } }
    : {}),
});

/** Reads a body stream chunk by chunk, with a deadline for the first byte and for every gap after it. */
async function readChunks(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  o: ElevenLabsTtsOptions,
  onChunk: (b: Uint8Array) => void,
): Promise<void> {
  const reader = body.getReader();
  const onAbort = (): void => void reader.cancel().catch(() => undefined);
  signal?.addEventListener('abort', onAbort, { once: true });
  let first = true;
  try {
    for (;;) {
      const ms = first ? (o.firstByteTimeoutMs ?? 8_000) : (o.chunkTimeoutMs ?? 5_000);
      let timer: NodeJS.Timeout | undefined;
      const step = await Promise.race([
        reader.read(),
        new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`elevenlabs tts: no ${first ? 'audio' : 'audio chunk'} within ${ms} ms`)), ms))),
      ]).finally(() => clearTimeout(timer));
      if (signal?.aborted) throw new Error('aborted');
      if (step.done) return;
      first = false;
      if (step.value.byteLength) onChunk(step.value);
    }
  } catch (e) {
    void reader.cancel().catch(() => undefined);
    throw e;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

const describe = (e: unknown): string => {
  const x = e as { statusCode?: number; message?: string; body?: { detail?: { message?: string; status?: string } | string } };
  const detail = typeof x?.body?.detail === 'string' ? x.body.detail : (x?.body?.detail?.message ?? x?.body?.detail?.status);
  return `${x?.statusCode ? `HTTP ${x.statusCode}` : 'error'}${detail ? `: ${String(detail).slice(0, 200)}` : x?.message ? `: ${x.message.slice(0, 200)}` : ''}`;
};

export class ElevenLabsTts implements Synthesizer, StreamingSynthesizer {
  constructor(private readonly o: ElevenLabsTtsOptions) {}

  async #open(text: string, language: TtsLanguage, signal: AbortSignal | undefined): Promise<ReadableStream<Uint8Array>> {
    if (signal?.aborted) throw new Error('aborted');
    try {
      // Bounded: the SDK retries on its own by default, which would hide a dead network behind long waits (a failed sentence falls back at once).
      return await this.o.client.textToSpeech.stream(this.o.voiceId, request(this.o, text, language), {
        maxRetries: 0,
        timeoutInSeconds: Math.max(1, Math.ceil((this.o.firstByteTimeoutMs ?? 8_000) / 1000)),
        ...(signal ? { abortSignal: signal } : {}),
      });
    } catch (e) {
      throw new Error(`elevenlabs tts ${describe(e)}`);
    }
  }

  /** Whole sentence at once (voice replies, stock phrases, the fallback when a stream fails before any audio). */
  async synthesize(text: string, language: TtsLanguage, signal?: AbortSignal): Promise<Synthesized> {
    const parts: Uint8Array[] = [];
    await this.synthesizeStream(text, language, signal, (c) => parts.push(c));
    const all = Buffer.concat(parts);
    if (!all.length) throw new Error('elevenlabs tts: the answer held no audio');
    return { pcm: new Uint8Array(all.buffer, all.byteOffset, all.length - (all.length % 2)), rateHz: ELEVENLABS_PCM_RATE_HZ };
  }

  /** Hands every chunk (even number of bytes) to `onChunk` the moment it arrives. */
  async synthesizeStream(text: string, language: TtsLanguage, signal: AbortSignal | undefined, onChunk: (pcm: Uint8Array) => void): Promise<void> {
    const body = await this.#open(text, language, signal);
    let carry: number | undefined; // a chunk may end in the middle of a 16-bit sample
    await readChunks(body, signal, this.o, (raw) => {
      let b = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
      if (carry !== undefined) b = Buffer.concat([Buffer.from([carry]), b]);
      carry = b.length % 2 ? b[b.length - 1] : undefined;
      const even = b.length - (b.length % 2);
      if (even) onChunk(new Uint8Array(b.buffer, b.byteOffset, even));
    }).catch((e: unknown) => {
      throw e instanceof Error && /^(aborted|elevenlabs)/.test(e.message) ? e : new Error(`elevenlabs tts ${describe(e)}`);
    });
  }
}
