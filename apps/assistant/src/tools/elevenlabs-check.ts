/**
 * Operator tool for the ElevenLabs voice.
 *   pnpm elevenlabs:check                          lists the account's voices (id, name) and the text-to-speech models with the languages they speak,
 *                                                  so ELEVENLABS_VOICE_ID and ELEVENLABS_TTS_MODEL can be chosen (is Uzbek in the list of the model?)
 *   pnpm elevenlabs:check -- --say "Salom ..."     synthesises the text with the configured voice and model into .local/elevenlabs-test.wav and prints
 *                                                  the time to the first audio chunk
 * Needs ELEVENLABS_API_KEY (and ELEVENLABS_VOICE_ID + ELEVENLABS_TTS_MODEL for --say) in .env. The key is never printed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { ElevenLabsTts, ELEVENLABS_PCM_RATE_HZ } from '../infrastructure/elevenlabs/tts.js';

const env = process.env;
if (!env.ELEVENLABS_API_KEY) {
  console.error('ELEVENLABS_API_KEY is not set (put it in .env)');
  process.exit(1);
}
const client = new ElevenLabsClient({ apiKey: env.ELEVENLABS_API_KEY });
const i = process.argv.indexOf('--say');
try {
  if (i < 0) {
    const models = (await client.models.list()).filter((m) => m.canDoTextToSpeech);
    console.log('Text-to-speech models (id, name, languages):');
    for (const m of models) {
      const langs = (m.languages ?? []).map((l) => l.languageId);
      const uz = langs.includes('uz') ? '  [Uzbek: yes]' : '  [Uzbek: not listed]';
      console.log(`${m.modelId}\t${m.name ?? ''}\t${langs.length} languages${uz}`);
    }
    const voices = await client.voices.search({ pageSize: 100 });
    console.log('\nVoices (id, name, category):');
    for (const v of voices.voices ?? []) console.log(`${v.voiceId}\t${v.name ?? ''}\t${v.category ?? ''}`);
    console.log('\nPut the voice id into ELEVENLABS_VOICE_ID and a model that lists Uzbek into ELEVENLABS_TTS_MODEL.');
  } else {
    if (!env.ELEVENLABS_VOICE_ID || !env.ELEVENLABS_TTS_MODEL)
      throw new Error('ELEVENLABS_VOICE_ID and ELEVENLABS_TTS_MODEL are not set (run without --say to list them)');
    const text = process.argv.slice(i + 1).join(' ') || 'Salom, men sizning yordamchingizman. Menga biror topshiriq bormi?';
    const tts = new ElevenLabsTts({
      client,
      voiceId: env.ELEVENLABS_VOICE_ID,
      model: env.ELEVENLABS_TTS_MODEL,
      languageCode: env.ELEVENLABS_LANGUAGE_CODE || 'uz',
      speed: env.ELEVENLABS_SPEED ? Number(env.ELEVENLABS_SPEED) : undefined,
      stability: env.ELEVENLABS_STABILITY ? Number(env.ELEVENLABS_STABILITY) : undefined,
    });
    const t0 = Date.now();
    let first = -1;
    const parts: Uint8Array[] = [];
    await tts.synthesizeStream(text, 'uz', undefined, (c) => {
      if (first < 0) first = Date.now() - t0;
      parts.push(c);
    });
    const total = Date.now() - t0;
    const pcm = Buffer.concat(parts);
    const dir = join(process.env.INIT_CWD ?? process.cwd(), '.local');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'elevenlabs-test.wav');
    const h = Buffer.alloc(44);
    h.write('RIFF', 0);
    h.writeUInt32LE(36 + pcm.length, 4);
    h.write('WAVEfmt ', 8);
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20);
    h.writeUInt16LE(1, 22);
    h.writeUInt32LE(ELEVENLABS_PCM_RATE_HZ, 24);
    h.writeUInt32LE(ELEVENLABS_PCM_RATE_HZ * 2, 28);
    h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34);
    h.write('data', 36);
    h.writeUInt32LE(pcm.length, 40);
    writeFileSync(file, Buffer.concat([h, pcm]));
    console.log(`ok: ${(pcm.length / 2 / ELEVENLABS_PCM_RATE_HZ).toFixed(1)} s of audio, first chunk after ${first} ms, all after ${total} ms -> ${file}`);
  }
} catch (e) {
  console.error(String((e as Error).message ?? e).slice(0, 300));
  process.exit(1);
}
