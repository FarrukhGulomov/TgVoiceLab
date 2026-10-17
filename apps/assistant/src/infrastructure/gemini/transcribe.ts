import type { TranscriptionPort, Transcript } from '../../application/ports.js';

/**
 * Voice-note transcription through the Gemini `generateContent` REST API (inline audio, JSON answer).
 * STATUS: NOT LIVE VERIFIED against Google's API (unreachable when written). Nothing is defaulted: the model comes from configuration.
 * Gemini returns no confidence score, so the model is asked to say whether it is sure; "not sure" maps to a confidence below the intake
 * threshold, which makes the owner confirm the text instead of acting on it. The audio is the owner's own voice note; on the free tier
 * Google may use it to improve its products.
 */
export interface GeminiTranscriptionOptions {
  apiKey: string;
  model: string;
  /** Test seam. */
  fetchImpl?: typeof fetch;
  endpoint?: string;
  timeoutMs?: number;
}

/** Just above the intake threshold (0.7): a transcript without a self-assessment is usable, a self-declared unsure one is not. */
const PLAIN_TEXT_CONFIDENCE = 0.75;

const PROMPT = [
  'Transcribe this voice message exactly as spoken. The speaker most likely speaks Uzbek (Latin script); Russian and English are also possible.',
  'Write Uzbek in Latin script. Do not translate, summarize, add or answer anything.',
  'Reply ONLY with JSON: {"text": string, "confident": boolean, "language": string}.',
  '"confident" is false if parts of the audio were unclear, noisy, or you had to guess words or numbers (dates, times, names). If there is no speech, text is "".',
].join(' ');

export class GeminiTranscription implements TranscriptionPort {
  constructor(private readonly o: GeminiTranscriptionOptions) {}

  async transcribe(audio: { bytes: Uint8Array; mime: string; durationSeconds: number }): Promise<Transcript> {
    const f = this.o.fetchImpl ?? fetch;
    const base = this.o.endpoint ?? 'https://generativelanguage.googleapis.com/v1beta';
    const res = await f(`${base}/models/${encodeURIComponent(this.o.model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.o.apiKey },
      body: JSON.stringify({
        contents: [
          { parts: [{ text: PROMPT }, { inline_data: { mime_type: audio.mime.split(';')[0]!.trim(), data: Buffer.from(audio.bytes).toString('base64') } }] },
        ],
        // No JSON mode: dedicated transcription models reject it ("JSON mode is not enabled for this model"). The prompt still asks for JSON; plain text is accepted too.
        generationConfig: { temperature: 0 },
      }),
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 30_000),
    });
    if (!res.ok) {
      // Google's error text explains a rejected request (unknown model, unsupported input). It never echoes our audio.
      let why = '';
      try {
        const e = (await res.json()) as { error?: { message?: unknown; status?: unknown } };
        why = [e.error?.status, e.error?.message]
          .filter((x) => typeof x === 'string')
          .join(': ')
          .slice(0, 300);
      } catch {
        /* no JSON body */
      }
      throw new Error(`transcription request failed: HTTP ${res.status}${why ? ` (${why})` : ''}`);
    }
    const body = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const raw = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    const fenced = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    let parsed: { text?: unknown; confident?: unknown; language?: unknown } | null = null;
    if (fenced.startsWith('{')) {
      try {
        parsed = JSON.parse(fenced);
      } catch {
        parsed = null;
      }
    }
    if (!parsed) {
      // A plain-text transcript carries no self-assessment. It is acted on only because every effect is echoed back to the owner
      // (exact title, date and time), so a mishearing is visible and can be corrected; an empty answer is "no speech".
      const plain = raw.trim();
      return plain ? { text: plain, confidence: PLAIN_TEXT_CONFIDENCE } : { text: '', confidence: 0 };
    }
    const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
    if (!text) return { text: '', confidence: 0 };
    return {
      text,
      confidence: parsed.confident === true ? 0.9 : 0.4,
      ...(typeof parsed.language === 'string' && parsed.language ? { language: parsed.language } : {}),
    };
  }
}
