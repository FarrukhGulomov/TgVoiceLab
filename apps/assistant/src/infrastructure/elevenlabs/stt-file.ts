import type { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import type { Transcript, TranscriptionPort } from '../../application/ports.js';

/**
 * ElevenLabs speech recognition for audio files (the owner's Telegram voice notes), through the SDK's `speechToText.convert`
 * (Scribe). An OGG/Opus voice note is sent as it is. The service reports how sure it is of the detected language, not of the words:
 * that is used as the confidence (the owner sees what was heard either way). NOT live verified from the build sandbox.
 */
export interface ElevenLabsFileSttOptions {
  client: Pick<ElevenLabsClient, 'speechToText'>;
  /** e.g. `scribe_v2`; never defaulted. */
  model: string;
  language?: string | undefined;
  timeoutMs?: number | undefined;
}

const NAME: Array<[RegExp, string]> = [
  [/webm/, 'voice.webm'],
  [/ogg|opus/, 'voice.ogg'],
  [/mpeg|mp3/, 'voice.mp3'],
  [/mp4|m4a|aac/, 'voice.m4a'],
  [/flac/, 'voice.flac'],
  [/wav|wave/, 'voice.wav'],
];

export class ElevenLabsFileStt implements TranscriptionPort {
  constructor(private readonly o: ElevenLabsFileSttOptions) {}

  async transcribe(audio: { bytes: Uint8Array; mime: string; durationSeconds: number }): Promise<Transcript> {
    const mime = audio.mime.split(';')[0]!.trim() || 'audio/ogg';
    const name = NAME.find(([re]) => re.test(mime))?.[1] ?? 'voice.ogg';
    const file = new File([Buffer.from(audio.bytes)], name, { type: mime });
    const res = (await this.o.client.speechToText
      .convert(
        { modelId: this.o.model, file, ...(this.o.language ? { languageCode: this.o.language } : {}), tagAudioEvents: false, diarize: false },
        {
          timeoutInSeconds: Math.ceil((this.o.timeoutMs ?? 60_000) / 1000),
          maxRetries: 0,
        },
      )
      .catch((e: unknown) => {
        const x = e as { statusCode?: number; message?: string };
        throw new Error(`elevenlabs stt ${x?.statusCode ? `HTTP ${x.statusCode}` : 'error'}: ${String(x?.message ?? e).slice(0, 200)}`);
      })) as { text?: string; languageCode?: string; languageProbability?: number };
    const text = (res.text ?? '').trim();
    if (!text) throw new Error('elevenlabs stt: no transcript in the answer');
    return { text, confidence: Math.max(0, Math.min(1, res.languageProbability ?? 0.8)), ...(res.languageCode ? { language: res.languageCode } : {}) };
  }
}
