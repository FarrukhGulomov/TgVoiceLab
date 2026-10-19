import { randomUUID } from 'node:crypto';
import type { Transcript, TranscriptionPort } from '../../application/ports.js';

/**
 * VoiceLab speech recognition for audio files (docs.voicelab.uz/api/stt):
 *   POST /v1/stt  (Authorization: Bearer, Idempotency-Key, multipart: audio, language, include_speakers)  ->  202 + job id (permission stt:write)
 *   GET /v1/stt/transcriptions/{id} until status = completed (permission stt:read)  ->  the transcript.
 * Formats: WAV, MP3, M4A/AAC, OGG/Opus, WebM/Opus, FLAC: a Telegram voice note (OGG/Opus) is sent as it is, nothing is decoded here.
 * The documentation was shared with us as prose: the exact JSON field names of the job id and of the transcript are read defensively
 * (several likely spellings), and an unrecognised shape is reported by its key names only, never by its content.
 */
export interface VoiceLabFileSttOptions {
  apiKey: string;
  baseUrl?: string | undefined;
  language?: string | undefined;
  pollIntervalMs?: number | undefined;
  timeoutMs?: number | undefined;
  /** Test seam. */
  fetchImpl?: typeof fetch | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

const EXT: Array<[RegExp, string]> = [
  [/webm/, 'voice.webm'],
  [/ogg|opus/, 'voice.ogg'],
  [/mpeg|mp3/, 'voice.mp3'],
  [/mp4|m4a|aac/, 'voice.m4a'],
  [/flac/, 'voice.flac'],
  [/wav|wave/, 'voice.wav'],
];
export const fileNameFor = (mime: string): string => EXT.find(([re]) => re.test(mime.toLowerCase()))?.[1] ?? 'voice.ogg';

type Json = Record<string, unknown>;
const obj = (x: unknown): Json => (x && typeof x === 'object' ? (x as Json) : {});
const pickStr = (...xs: unknown[]): string | undefined => xs.find((x): x is string => typeof x === 'string' && x.length > 0);

export function readJobId(j: unknown): string | undefined {
  const o = obj(j);
  const d = obj(o.data);
  return pickStr(o.id, o.job_id, o.transcription_id, d.id, d.job_id, d.transcription_id);
}
export function readStatus(j: unknown): string {
  const o = obj(j);
  return (pickStr(o.status, obj(o.data).status) ?? '').toLowerCase();
}
export function readText(j: unknown): { text: string; confidence?: number; language?: string } | undefined {
  const o = obj(j);
  const d = obj(o.data);
  const r = obj(o.result);
  const direct = pickStr(o.text, o.transcript, o.transcription, r.text, r.transcript, d.text, d.transcript);
  const segs = [o.segments, r.segments, d.segments, o.utterances, r.utterances].find(Array.isArray) as unknown[] | undefined;
  const text =
    direct ??
    (segs
      ? segs
          .map((s) => pickStr(obj(s).text) ?? '')
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
      : undefined);
  if (text === undefined) return undefined;
  const c = [o.confidence, r.confidence, d.confidence].find((x): x is number => typeof x === 'number');
  const language = pickStr(o.language, r.language, d.language);
  return { text, ...(c !== undefined ? { confidence: c > 1 ? c / 100 : c } : {}), ...(language ? { language } : {}) };
}

export class VoiceLabFileStt implements TranscriptionPort {
  constructor(private readonly o: VoiceLabFileSttOptions) {}

  #base(): string {
    return (this.o.baseUrl ?? 'https://api.voicelab.uz').replace(/\/+$/, '');
  }
  #scrub(s: string): string {
    return s.split(this.o.apiKey).join('***').slice(0, 300);
  }

  async transcribe(audio: { bytes: Uint8Array; mime: string; durationSeconds: number }): Promise<Transcript> {
    const f = this.o.fetchImpl ?? fetch;
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const deadline = Date.now() + (this.o.timeoutMs ?? 60_000);
    const mime = audio.mime.split(';')[0]!.trim() || 'audio/ogg';

    const form = new FormData();
    form.append('audio', new Blob([audio.bytes as unknown as ArrayBuffer], { type: mime }), fileNameFor(mime));
    form.append('language', this.o.language ?? 'uz');
    form.append('include_speakers', 'false');
    const up = await f(`${this.#base()}/v1/stt`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.o.apiKey}`, 'Idempotency-Key': randomUUID() },
      body: form,
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 60_000),
    });
    if (up.status !== 202 && !up.ok) throw new Error(`voicelab stt upload HTTP ${up.status}: ${this.#scrub(await up.text().catch(() => ''))}`);
    const upJson: unknown = await up.json().catch(() => ({}));
    // Some deployments answer 200 with the finished transcript; accept it.
    const early = readStatus(upJson) === 'completed' ? readText(upJson) : undefined;
    if (early) return this.#result(early);
    const id = readJobId(upJson);
    if (!id) throw new Error(`voicelab stt: no job id in the answer (keys: ${Object.keys(obj(upJson)).join(', ') || 'none'})`);

    for (;;) {
      if (Date.now() > deadline) throw new Error('voicelab stt: the transcript was not ready in time');
      await sleep(this.o.pollIntervalMs ?? 600);
      const r = await f(`${this.#base()}/v1/stt/transcriptions/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${this.o.apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) throw new Error(`voicelab stt poll HTTP ${r.status}: ${this.#scrub(await r.text().catch(() => ''))}`);
      const j: unknown = await r.json().catch(() => ({}));
      const status = readStatus(j);
      if (status === 'failed' || status === 'error') throw new Error(`voicelab stt: the job failed (${status})`);
      if (status === 'completed' || status === 'done' || status === 'succeeded') {
        const t = readText(j);
        if (!t) throw new Error(`voicelab stt: no transcript in the answer (keys: ${Object.keys(obj(j)).join(', ') || 'none'})`);
        return this.#result(t);
      }
    }
  }

  #result(t: { text: string; confidence?: number; language?: string }): Transcript {
    // The service reports no confidence we can rely on: without one, the text is usable (the owner still sees what was heard).
    return { text: t.text.trim(), confidence: t.confidence ?? 0.8, ...(t.language ? { language: t.language } : {}) };
  }
}
