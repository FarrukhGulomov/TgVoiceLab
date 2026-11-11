import { spawn } from 'node:child_process';
import type { VoiceReplyPort } from '../../application/ports.js';
import { languageOf, speakable } from './mouth-link.js';
import type { Synthesizer } from './tts.js';

const MAX_CHARS = 500;
/** A runaway loop (or a flood of voice notes) must not drain the VoiceLab credit: at most this many spoken replies per rolling hour. */
const MAX_PER_HOUR = 40;

/** s16le mono PCM -> OGG/Opus (what Telegram shows as a voice note), through the system `ffmpeg`. */
export function encodeOpus(pcm: Uint8Array, rateHz: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', [
      '-v',
      'error',
      '-f',
      's16le',
      '-ar',
      String(rateHz),
      '-ac',
      '1',
      '-i',
      'pipe:0',
      '-c:a',
      'libopus',
      '-b:a',
      '32k',
      '-f',
      'ogg',
      'pipe:1',
    ]);
    const out: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (b: Buffer) => out.push(b));
    p.stderr.on('data', (b: Buffer) => (err += b.toString()));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg exited ${code}: ${err.slice(0, 200)}`))));
    p.stdin.on('error', () => undefined);
    p.stdin.end(Buffer.from(pcm));
  });
}

export async function ffmpegAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-version']);
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

/** Speaks short replies in the VoiceLab voice. Long replies are not spoken (the text carries them). */
export class VoiceReplies implements VoiceReplyPort {
  constructor(
    private readonly tts: Synthesizer,
    private readonly send: (to: string, ogg: Buffer, durationSeconds: number, key: string) => Promise<void>,
    private readonly encode: (pcm: Uint8Array, rateHz: number) => Promise<Buffer> = encodeOpus,
    private readonly log?: (line: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  #sent: number[] = [];

  async speak(to: string, text: string, key: string): Promise<void> {
    const t = speakable(text);
    if (!/[\p{L}\p{N}]/u.test(t) || t.length > MAX_CHARS) return;
    const t0 = this.now();
    this.#sent = this.#sent.filter((x) => t0 - x < 3_600_000);
    if (this.#sent.length >= MAX_PER_HOUR) {
      this.log?.('voice reply skipped: hourly limit reached');
      return;
    }
    this.#sent.push(t0);
    try {
      const a = await this.tts.synthesize(t, languageOf(t));
      const ogg = await this.encode(a.pcm, a.rateHz);
      await this.send(to, ogg, Math.max(1, Math.round(a.pcm.length / 2 / a.rateHz)), key);
    } catch (e) {
      this.log?.(`voice reply failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
  }
}
