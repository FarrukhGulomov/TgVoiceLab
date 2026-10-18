/**
 * Operator tool for the VoiceLab voice.
 *   pnpm voicelab:check                      lists the account's Uzbek voices (id, name) so VOICELAB_VOICE_ID can be set
 *   pnpm voicelab:check -- --say "Salom ..."  synthesises the text with VOICELAB_VOICE_ID into .local/voicelab-test.wav and prints the delay
 * Needs VOICELAB_API_KEY (and VOICELAB_VOICE_ID for --say) in .env. The key is never printed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { VoiceLabTts } from '../infrastructure/voicelab/tts.js';

const env = process.env;
if (!env.VOICELAB_API_KEY) {
  console.error('VOICELAB_API_KEY is not set (put it in .env)');
  process.exit(1);
}
const tts = new VoiceLabTts({
  apiKey: env.VOICELAB_API_KEY,
  voiceId: env.VOICELAB_VOICE_ID ?? '',
  baseUrl: env.VOICELAB_BASE_URL || undefined,
  model: env.VOICELAB_TTS_MODEL || undefined,
  speed: env.VOICELAB_SPEED ? Number(env.VOICELAB_SPEED) : undefined,
});
const i = process.argv.indexOf('--say');
try {
  if (i < 0) {
    const voices = await tts.listVoices('uz');
    for (const v of voices) console.log(`${v.id}\t${v.display_name}\t${v.description ?? ''}`);
    console.log(`\n${voices.length} voice(s). Put the id of the one you want into VOICELAB_VOICE_ID.`);
  } else {
    if (!env.VOICELAB_VOICE_ID) throw new Error('VOICELAB_VOICE_ID is not set (run without --say to list voices)');
    const text = process.argv.slice(i + 1).join(' ') || 'Salom Farruh, men sizning yordamchingizman. Menga biror topshiriq bormi?';
    const t0 = Date.now();
    const a = await tts.synthesize(text, 'uz');
    const ms = Date.now() - t0;
    mkdirSync('.local', { recursive: true });
    const h = Buffer.alloc(44);
    h.write('RIFF', 0);
    h.writeUInt32LE(36 + a.pcm.length, 4);
    h.write('WAVEfmt ', 8);
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20);
    h.writeUInt16LE(1, 22);
    h.writeUInt32LE(a.rateHz, 24);
    h.writeUInt32LE(a.rateHz * 2, 28);
    h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34);
    h.write('data', 36);
    h.writeUInt32LE(a.pcm.length, 40);
    writeFileSync('.local/voicelab-test.wav', Buffer.concat([h, Buffer.from(a.pcm)]));
    console.log(`ok: ${(a.pcm.length / 2 / a.rateHz).toFixed(1)} s of audio at ${a.rateHz} Hz, synthesised in ${ms} ms -> .local/voicelab-test.wav`);
  }
} catch (e) {
  console.error(String((e as Error).message ?? e));
  process.exit(1);
}
