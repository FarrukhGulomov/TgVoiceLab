/**
 * Operator tool: compares speech recognisers on YOUR recordings, with the same audio and the same scoring.
 *   pnpm voicelab:stt-bench -- <folder>
 * The folder holds recordings (.ogg .opus .mp3 .m4a .wav .webm .flac) and, next to each, an optional reference text `name.txt` (what was really said).
 * Runs VoiceLab (file API) and, when GEMINI_API_KEY + GEMINI_TRANSCRIPTION_MODEL are set, Gemini; prints the time and, with references, the word error
 * rate of each. For 16 kHz mono .wav files it also measures VoiceLab's live (WebSocket) commit -> final delay.
 * It measures; it does not decide. Needs a few real recordings of your own voice on the phone line. Keys are never printed.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { extname, join, basename } from 'node:path';
import type { TranscriptionPort } from '../application/ports.js';
import { GeminiTranscription } from '../infrastructure/gemini/transcribe.js';
import { VoiceLabFileStt } from '../infrastructure/voicelab/stt-file.js';
import { VoiceLabSttStream } from '../infrastructure/voicelab/stt-stream.js';
import { wer } from '../infrastructure/voicelab/wer.js';

const env = process.env;
const dir = process.argv.slice(2).find((a) => a !== '--');
if (!dir) {
  console.error('usage: pnpm voicelab:stt-bench -- <folder with recordings>');
  process.exit(1);
}
const MIME: Record<string, string> = {
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.flac': 'audio/flac',
};
const files = readdirSync(dir)
  .filter((f) => MIME[extname(f).toLowerCase()])
  .sort();
if (!files.length) {
  console.error(`no recordings in ${dir}`);
  process.exit(1);
}

const engines: Array<{ name: string; port: TranscriptionPort }> = [];
if (env.VOICELAB_API_KEY)
  engines.push({
    name: 'voicelab',
    port: new VoiceLabFileStt({ apiKey: env.VOICELAB_API_KEY, baseUrl: env.VOICELAB_BASE_URL || undefined, language: env.VOICELAB_STT_LANGUAGE || 'uz' }),
  });
if (env.GEMINI_API_KEY && env.GEMINI_TRANSCRIPTION_MODEL)
  engines.push({ name: 'gemini', port: new GeminiTranscription({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_TRANSCRIPTION_MODEL }) });
if (!engines.length) {
  console.error('no recogniser configured (VOICELAB_API_KEY and/or GEMINI_API_KEY + GEMINI_TRANSCRIPTION_MODEL in .env)');
  process.exit(1);
}

const sums = new Map<string, { n: number; ms: number; wer: number; scored: number }>();
for (const f of files) {
  const bytes = new Uint8Array(readFileSync(join(dir, f)));
  const refPath = join(dir, `${basename(f, extname(f))}.txt`);
  const ref = existsSync(refPath) ? readFileSync(refPath, 'utf8') : undefined;
  console.log(`\n== ${f}${ref ? '' : '  (no reference text: time only)'}`);
  for (const e of engines) {
    const t0 = Date.now();
    try {
      const r = await e.port.transcribe({ bytes, mime: MIME[extname(f).toLowerCase()]!, durationSeconds: 0 });
      const ms = Date.now() - t0;
      const w = ref !== undefined ? wer(ref, r.text) : undefined;
      const s = sums.get(e.name) ?? { n: 0, ms: 0, wer: 0, scored: 0 };
      s.n++;
      s.ms += ms;
      if (w !== undefined) {
        s.wer += w;
        s.scored++;
      }
      sums.set(e.name, s);
      console.log(`  ${e.name.padEnd(9)} ${String(ms).padStart(6)} ms${w !== undefined ? `  WER ${(w * 100).toFixed(1)}%` : ''}  «${r.text.slice(0, 120)}»`);
    } catch (err) {
      console.log(
        `  ${e.name.padEnd(9)} FAILED: ${String((err as Error).message)
          .replace(env.VOICELAB_API_KEY ?? '\u0000', '***')
          .slice(0, 160)}`,
      );
    }
  }
}

console.log('\n== summary (lower is better)');
for (const [name, s] of sums)
  console.log(
    `  ${name.padEnd(9)} ${s.n} file(s), mean ${(s.ms / s.n).toFixed(0)} ms${s.scored ? `, mean WER ${((s.wer / s.scored) * 100).toFixed(1)}% over ${s.scored} reference(s)` : ', no references'}`,
  );

// Live path: how long from the commit to the final transcript (16 kHz mono 16-bit WAV with a 44-byte header only).
if (env.VOICELAB_API_KEY) {
  const url = env.VOICELAB_STT_URL || `${(env.VOICELAB_BASE_URL || 'https://api.voicelab.uz').replace(/\/+$/, '').replace(/^http/, 'ws')}/v1/stt/stream`;
  for (const f of files.filter((x) => extname(x).toLowerCase() === '.wav')) {
    const buf = readFileSync(join(dir, f));
    if (buf.readUInt32LE(24) !== 16_000 || buf.readUInt16LE(22) !== 1 || buf.readUInt16LE(34) !== 16) continue;
    const pcm = new Uint8Array(buf.subarray(44));
    const ms = (pcm.length / 2 / 16_000) * 1000;
    if (ms < 150 || ms > 34_000) continue;
    const stream = new VoiceLabSttStream({ apiKey: env.VOICELAB_API_KEY, url, language: env.VOICELAB_STT_LANGUAGE || 'uz', sampleRateHz: 16_000 });
    const out = await new Promise<string>((resolve) => {
      let committedAt = 0;
      const timer = setTimeout(() => resolve('timeout after 20 s'), 20_000);
      stream.onFinal((fin) => {
        clearTimeout(timer);
        resolve(`commit -> final ${Date.now() - committedAt} ms  «${fin.text.slice(0, 100)}»`);
      });
      stream.onError((m) => {
        clearTimeout(timer);
        resolve(`error: ${m}`);
      });
      for (let i = 0; i < pcm.length; i += 3200) stream.sendAudio(pcm.subarray(i, i + 3200));
      committedAt = Date.now();
      stream.commit();
    });
    stream.close();
    console.log(`  live ${f}: ${out}`);
  }
}
