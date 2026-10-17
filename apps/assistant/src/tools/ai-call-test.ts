/**
 * OPERATOR-RUN live test: the assistant rings the owner's own phone and an AI (OpenAI Realtime) talks on the call.
 *
 * This is a test tool, NOT the production call path: it dials directly through the production adapter and bypasses the orchestrator,
 * dial policy, budget and kill switch on purpose, so it is guarded like the other live spikes (explicit opt-in, a bounded time
 * window, a hard duration cap) and it never enables calling in the service. It costs real money (OpenAI audio) while the call lasts.
 *
 *   LIVE_TEST_OPT_IN=yes  LIVE_TEST_RECIPIENT_ID=<numeric id>  LIVE_TEST_RECIPIENT_CONSENT=yes
 *   LIVE_TEST_WINDOW_START / LIVE_TEST_WINDOW_END  (ISO instants, at most 2 h apart)
 *   LIVE_TEST_MAX_SECONDS (default 120, max 600)
 *   OPENAI_API_KEY  OPENAI_REALTIME_MODEL  [OPENAI_VOICE]  [OPENAI_REALTIME_DIALECT=ga|beta]  [OPENAI_TRANSCRIPTION_MODEL]
 */
import { randomUUID } from 'node:crypto';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import type { ApprovedCallPlan, CallEvent } from '@tgvl/contracts';
import { NtgcallsCallAdapter } from '../modules/calls/ntgcalls/adapter.js';
import { RealtimeCallBridge } from '../modules/calls/audio/realtime-bridge.js';
import { GramjsCallTransport } from '../infrastructure/telegram/gramjs-call-transport.js';
import { createNtgcallsMedia, ntgcallsProtocol } from '../infrastructure/telegram/ntgcalls-media.js';
import { OpenAiRealtimeLink } from '../infrastructure/openai/realtime.js';
import { resolveSecret } from '../infrastructure/crypto/secrets.js';

const env = process.env;
const problems: string[] = [];
const need = (k: string) => {
  const v = env[k];
  if (!v) problems.push(`${k} is required`);
  return v ?? '';
};
if (env.LIVE_TEST_OPT_IN !== 'yes') problems.push('LIVE_TEST_OPT_IN=yes (explicit opt-in to place a real call and spend OpenAI credit)');
if (env.LIVE_TEST_RECIPIENT_CONSENT !== 'yes') problems.push('LIVE_TEST_RECIPIENT_CONSENT=yes (the participant knows the call is coming and agreed)');
const recipientId = env.LIVE_TEST_RECIPIENT_ID ?? '';
if (!/^[1-9]\d{0,18}$/.test(recipientId)) problems.push('LIVE_TEST_RECIPIENT_ID=<numeric Telegram id>');
const winStart = Date.parse(env.LIVE_TEST_WINDOW_START ?? '');
const winEnd = Date.parse(env.LIVE_TEST_WINDOW_END ?? '');
if (!Number.isFinite(winStart) || !Number.isFinite(winEnd) || winEnd <= winStart)
  problems.push('LIVE_TEST_WINDOW_START / LIVE_TEST_WINDOW_END (ISO instants) are required');
else if (winEnd - winStart > 2 * 3600_000) problems.push('the test window must be at most 2 hours');
else if (Date.now() < winStart || Date.now() > winEnd) problems.push(`now (${new Date().toISOString()}) is outside the authorized test window`);
const maxSeconds = Number(env.LIVE_TEST_MAX_SECONDS ?? '120');
if (!Number.isInteger(maxSeconds) || maxSeconds < 20 || maxSeconds > 600) problems.push('LIVE_TEST_MAX_SECONDS must be an integer between 20 and 600');
const apiId = Number(need('TELEGRAM_API_ID'));
const apiHash = need('TELEGRAM_API_HASH');
const sessionRef = need('TELEGRAM_SESSION_SECRET_REF');
const apiKey = need('OPENAI_API_KEY');
const model = need('OPENAI_REALTIME_MODEL');
const dialect = env.OPENAI_REALTIME_DIALECT === 'beta' ? 'beta' : 'ga';
if (problems.length) {
  console.error(`BLOCKED_EXTERNAL — the AI call test did not run (that is NOT a pass):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(2);
}

const INSTRUCTIONS = [
  "Sen egasining shaxsiy sun'iy intellekt yordamchisisan. Bu sinov qo'ng'irog'i.",
  "Suhbatni o'zbek tilida olib bor, odam boshqa tilda gapirsa shu tilga o't.",
  "Qo'ng'iroq ko'tarilganda sen birinchi gapirasan: o'zingni AI yordamchi deb tanishtirasan. Qo'ng'iroq allaqachon davom etayotgandek javob berma.",
  "Qisqa gapir: bir-ikki jumla. Odam gapira boshlasa, to'xta va tingla.",
  "Hech qanday vazifa, eslatma yoki qo'ng'iroq qilishga va'da berma: bu faqat ovoz sinovi.",
].join(' ');
// `response.create` instructions are a directive to the model, not text to read out: a bare greeting was answered as if it were a question.
const GREETING =
  "Qo'ng'iroqqa hozir javob berildi. Faqat shu gapni ayt, keyin jim bo'l va tingla: «Salom! Men sizning shaxsiy AI yordamchingizman. Bu sinov qo'ng'irog'i.» Boshqa narsa qo'shma.";

const client = new TelegramClient(new StringSession(resolveSecret(sessionRef)), apiId, apiHash, { connectionRetries: 3 });
await client.connect();
if (!(await client.isUserAuthorized())) {
  console.error('the stored Telegram session is not authorized; run `pnpm spike:login` first');
  process.exit(2);
}
const me = (await client.getMe()) as Api.User;
if (me.id.toString() === recipientId) {
  console.error('LIVE_TEST_RECIPIENT_ID is the assistant account itself');
  process.exit(2);
}
console.log(`assistant ${me.id.toString()} -> ${recipientId}; up to ${maxSeconds}s; model=${model} dialect=${dialect}`);

const adapter = new NtgcallsCallAdapter({
  transport: new GramjsCallTransport(client, () => me.id.toString(), ntgcallsProtocol()),
  media: createNtgcallsMedia,
  buildFingerprint: 'ai-call-test',
});
const plan: ApprovedCallPlan = {
  callRequestId: randomUUID(),
  ownerId: randomUUID(),
  recipientTelegramId: recipientId,
  topic: 'ai_voice_test',
  purpose: 'operator-run AI voice test',
  questions: [],
  allowedContext: [],
  forbiddenCommitments: [],
  language: 'uz',
  maxDurationSeconds: maxSeconds,
  authorizationId: randomUUID(),
  permissionVersion: 0,
  planHash: 'f'.repeat(64),
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
};

const started = Date.now();
const t = () => `[+${((Date.now() - started) / 1000).toFixed(1)}s]`;
const ac = new AbortController();
const handle = await adapter.dial(plan, ac.signal);
console.log(`${t()} dialing... answer the call on your phone`);

const link = new OpenAiRealtimeLink({
  apiKey,
  model,
  voice: env.OPENAI_VOICE,
  instructions: INSTRUCTIONS,
  dialect,
  transcriptionModel: env.OPENAI_TRANSCRIPTION_MODEL,
});
const bridge = new RealtimeCallBridge(handle, link, (line) => console.log(`${t()} ${line}`));
let ended: CallEvent | null = null;
let hangupTimer: NodeJS.Timeout | undefined;
const hangup = async (why: 'duration_limit' | 'cancelled') => {
  console.log(`${t()} hanging up (${why})`);
  await handle
    .end(why)
    .catch((e: unknown) => console.error(`hangup failed: ${String((e as Error)?.message ?? e)} — END THE CALL MANUALLY from the Telegram client`));
};
process.on('SIGINT', () => void hangup('cancelled'));

for await (const ev of handle.events) {
  if (ev.type === 'heartbeat') continue;
  console.log(`${t()} event: ${ev.type}${ev.reason ? ` (${ev.reason})` : ''}`);
  if (ev.type === 'connected') {
    bridge.start(GREETING);
    hangupTimer = setTimeout(() => void hangup('duration_limit'), maxSeconds * 1000);
  }
  if (ev.type === 'ended' || ev.type === 'error') {
    ended = ev;
    break;
  }
}
clearTimeout(hangupTimer);
bridge.stop();
console.log(JSON.stringify({ endedReason: ended?.reason ?? null, stats: bridge.stats }, null, 2));
await client.disconnect();
process.exit(bridge.stats.errors.length ? 1 : 0);
