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
 *   AI_CALL_MODE=chat (default) | briefing   (briefing: the AI reads the owner's real tasks from DATABASE_URL and can complete/move them; the recipient MUST be the owner)
 *   AI_VOICE_PROVIDER=openai (default) | gemini
 *   openai: OPENAI_API_KEY  OPENAI_REALTIME_MODEL  [OPENAI_VOICE]  [OPENAI_REALTIME_DIALECT=ga|beta]  [OPENAI_TRANSCRIPTION_MODEL]
 *   gemini: GEMINI_API_KEY  GEMINI_LIVE_MODEL  [GEMINI_VOICE]  [GEMINI_TEXT_MODE=realtime|client_content]  [GEMINI_GOOGLE_SEARCH=on]  [GEMINI_DEBUG=on]  [GEMINI_LANGUAGE_CODE=uz-UZ]
 */
import { randomUUID } from 'node:crypto';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import type { ApprovedCallPlan, CallEvent } from '@tgvl/contracts';
import { NtgcallsCallAdapter } from '../modules/calls/ntgcalls/adapter.js';
import { RealtimeCallBridge, type ToolDeclaration } from '../modules/calls/audio/realtime-bridge.js';
import { GramjsCallTransport } from '../infrastructure/telegram/gramjs-call-transport.js';
import { createNtgcallsMedia, ntgcallsProtocol } from '../infrastructure/telegram/ntgcalls-media.js';
import { OpenAiRealtimeLink } from '../infrastructure/openai/realtime.js';
import { GeminiLiveLink } from '../infrastructure/gemini/live.js';
import { resolveSecret } from '../infrastructure/crypto/secrets.js';
import { loadConfig } from '../bootstrap/config.js';
import { Db } from '../infrastructure/db/db.js';
import { DataCrypto } from '../infrastructure/crypto/data-crypto.js';
import { Envelope, parseKeyRing } from '../infrastructure/crypto/envelope.js';
import { TaskService } from '../modules/tasks/tasks.service.js';
import { ReminderService } from '../modules/scheduling/reminders.service.js';
import { systemClock } from '../application/clock.js';
import { OWNER_CALL_TOOL_DECLARATIONS, OwnerCallTools, buildOwnerCallInstructions } from '../modules/calls/conversation/owner-call-tools.js';

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
const provider = env.AI_VOICE_PROVIDER === 'gemini' ? 'gemini' : 'openai';
if (env.AI_VOICE_PROVIDER && !['openai', 'gemini'].includes(env.AI_VOICE_PROVIDER)) problems.push('AI_VOICE_PROVIDER must be openai or gemini');
const apiKey = need(provider === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY');
const model = need(provider === 'gemini' ? 'GEMINI_LIVE_MODEL' : 'OPENAI_REALTIME_MODEL');
const dialect = env.OPENAI_REALTIME_DIALECT === 'beta' ? 'beta' : 'ga';
if (problems.length) {
  console.error(`BLOCKED_EXTERNAL — the AI call test did not run (that is NOT a pass):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(2);
}

const CHAT_INSTRUCTIONS = [
  "Sen egasining shaxsiy sun'iy intellekt yordamchisisan. Bu sinov qo'ng'irog'i.",
  "SUHBAT TILI: O'ZBEK. Foydalanuvchi o'zbek tilida gapiradi, hatto eshitilishi boshqa tilga (turkcha, ruscha, nemischa) o'xshab ketsa ham. Har doim o'zbek tilida javob ber. Faqat foydalanuvchi aniq 'inglizcha gapir' yoki 'ruscha gapir' desagina o'sha tilga o't va so'ng yana o'zbekchaga qayt.",
  "Qo'ng'iroq ko'tarilganda sen birinchi gapirasan: o'zingni AI yordamchi deb tanishtirasan. Qo'ng'iroq allaqachon davom etayotgandek javob berma.",
  "Suhbat tugaganda (odam 'xayr', 'sog' bo'ling' desa yoki boshqa savoli yo'qligini aytsa) avval qisqa xayrlash, so'ng end_call vositasini chaqir.",
  "Qisqa gapir: bir-ikki jumla. Odam gapira boshlasa, to'xta va tingla.",
  "Umumiy bilim savollariga (davlat poytaxti, tarix, fan, tarjima, oddiy maslahat) o'z bilimingdan to'g'ridan-to'g'ri qisqa javob ber; bunday savollarni rad etma. Aniq bilmasang, shuni ayt.",
  "Faqat quyidagilarni BILMAYSAN va qila olmaysan: hozirgi vaqtni (uni taxmin qilma), egasining vazifa/eslatma/kontaktlarini, eslatma o'rnatish yoki qo'ng'iroq qilishni. Bularni so'rashsa, buni ochiq ayt va hech narsani eslab qolishga yoki bajarishga va'da berma ('eslatib qo'yaman' dema).",
].join(' ');
// `response.create` instructions are a directive to the model, not text to read out: a bare greeting was answered as if it were a question.
const CHAT_TOOLS: ToolDeclaration[] = [
  {
    name: 'end_call',
    description:
      "Qo'ng'iroqni tugatadi. FAQAT odam aniq xayrlashganda ('xayr', 'sog' bo'ling', 'boshqa savolim yo'q') chaqir: avval qisqa xayrlash, KEYIN shu vositani chaqir. Suhbat o'rtasida yoki o'z javobingdan keyin hech qachon chaqirma.",
    parameters: { type: 'object', properties: { reason: { type: 'string', description: 'Qisqa sabab' } }, required: [] },
  },
];
const CHAT_GREETING =
  "Qo'ng'iroqqa hozir javob berildi. Faqat shu gapni ayt, keyin jim bo'l va tingla: «Salom! Men sizning shaxsiy AI yordamchingizman. Bu sinov qo'ng'irog'i.» Boshqa narsa qo'shma.";

const briefingMode = env.AI_CALL_MODE === 'briefing';
let INSTRUCTIONS = CHAT_INSTRUCTIONS;
let TOOLS = CHAT_TOOLS;
let GREETING = CHAT_GREETING;
let ownerTools: OwnerCallTools | null = null;
let onEndCall: () => void | Promise<void> = () => undefined;
let closeDb: () => Promise<void> = async () => undefined;
if (briefingMode) {
  // Real owner data: read from the database as the owner (bound server-side), only ever to the owner's own number.
  const cfg = loadConfig();
  const db = new Db(cfg.DATABASE_URL);
  closeDb = () => db.close();
  const owners = (
    await db.query<{ id: string; timezone: string; telegram_user_id: string }>('SELECT id, timezone, telegram_user_id FROM owners ORDER BY created_at')
  ).rows;
  const owner = owners[0];
  if (owners.length !== 1 || !owner) {
    console.error(`AI_CALL_MODE=briefing needs exactly one owner in the database (found ${owners.length}); run bootstrap:owner first`);
    process.exit(2);
  }
  if (owner.telegram_user_id !== recipientId) {
    console.error('AI_CALL_MODE=briefing may only call the owner: LIVE_TEST_RECIPIENT_ID is not the configured owner');
    process.exit(2);
  }
  const crypto = new DataCrypto(new Envelope(parseKeyRing(resolveSecret(cfg.DATA_ENCRYPTION_KEY_REF!))));
  ownerTools = new OwnerCallTools({
    db,
    tasks: new TaskService(crypto),
    reminders: new ReminderService(db, crypto, systemClock),
    clock: systemClock,
    ownerId: owner.id,
    timezone: owner.timezone,
    onEndCall: () => onEndCall(),
  });
  await ownerTools.load();
  INSTRUCTIONS = buildOwnerCallInstructions({ now: new Date(), timezone: owner.timezone, tasks: ownerTools.describeList() });
  TOOLS = OWNER_CALL_TOOL_DECLARATIONS;
  GREETING = "Qo'ng'iroqqa hozir javob berildi. Brifingni boshla: o'zingni tanishtir va vazifalarni qisqa o'qib ber.";
  console.log(`briefing mode: ${ownerTools.describeList().length} task(s) in scope for the briefing`);
}

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
console.log(
  `assistant ${me.id.toString()} -> ${recipientId}; up to ${maxSeconds}s; provider=${provider} model=${model}${provider === 'openai' ? ` dialect=${dialect}` : ''}`,
);

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

const link =
  provider === 'gemini'
    ? new GeminiLiveLink({
        apiKey,
        model,
        voice: env.GEMINI_VOICE,
        instructions: INSTRUCTIONS,
        textMode: env.GEMINI_TEXT_MODE === 'client_content' ? 'client_content' : 'realtime',
        googleSearch: env.GEMINI_GOOGLE_SEARCH === 'on',
        tools: TOOLS,
        debug: env.GEMINI_DEBUG === 'on' ? (line) => console.log(`${t()} gemini: ${line}`) : undefined,
        languageCode: env.GEMINI_LANGUAGE_CODE || undefined,
      })
    : new OpenAiRealtimeLink({
        apiKey,
        model,
        voice: env.OPENAI_VOICE,
        instructions: INSTRUCTIONS,
        dialect,
        tools: TOOLS,
        transcriptionModel: env.OPENAI_TRANSCRIPTION_MODEL,
      });
const bridge = new RealtimeCallBridge(handle, link, {
  log: (line) => console.log(`${t()} ${line}`),
  onTool: (call) => {
    if (ownerTools) return ownerTools.execute(call);
    if (call.name !== 'end_call') return { result: { error: `unknown tool ${call.name}` } };
    // Only the application ends the call, and only after the farewell has been played to the caller.
    return { result: { ok: true }, respond: false, afterPlayout: () => hangup('completed') };
  },
});
let ended: CallEvent | null = null;
let hangupTimer: NodeJS.Timeout | undefined;
const hangup = async (why: 'duration_limit' | 'cancelled' | 'completed') => {
  console.log(`${t()} hanging up (${why})`);
  await handle
    .end(why)
    .catch((e: unknown) => console.error(`hangup failed: ${String((e as Error)?.message ?? e)} — END THE CALL MANUALLY from the Telegram client`));
};
onEndCall = () => hangup('completed');
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
await closeDb();
process.exit(bridge.stats.errors.length ? 1 : 0);
