import { readdirSync } from 'node:fs';
import { DateTime } from 'luxon';
import { loadConfig } from './bootstrap/config.js';
import { buildContainer } from './bootstrap/container.js';
import { DbWatermarkStore } from './infrastructure/telegram/recovery.js';
import { verifyConfiguredOwner } from './bootstrap/owner-check.js';
import { drainWorker, startLane } from './bootstrap/worker.js';
import { leastPrivilegeViolations } from './infrastructure/db/role-check.js';
import { sealLegacyPlaintext } from './modules/retention/seal-legacy.js';
import { createLogger } from './infrastructure/observability/logger.js';
import { Db } from './infrastructure/db/db.js';
import { MIGRATIONS_DIR } from './infrastructure/db/paths.js';
import { Envelope, parseKeyRing } from './infrastructure/crypto/envelope.js';
import { DataCrypto } from './infrastructure/crypto/data-crypto.js';
import { resolveSecret } from './infrastructure/crypto/secrets.js';
import { systemClock } from './application/clock.js';
import { DisabledMessaging } from './infrastructure/telegram/disabled-messaging.js';
import { FakeCallAdapter, FakeMessaging } from './testing/fakes.js';
import { DisabledCallAdapter, EvidenceGatedCallAdapter } from './modules/calls/adapters.js';
import { fileURLToPath } from 'node:url';
import { computeBuildFingerprint, deriveCapabilities } from './modules/calls/capability-evidence.js';
import { ensureDailyBudget } from './modules/operations/operations.service.js';
import { buildServer } from './http/server.js';
import type { MessagingPort } from './application/ports.js';
import type { TelegramCallAdapter } from '@tgvl/contracts';

const cfg = loadConfig();
const log = createLogger(cfg.LOG_LEVEL);
const db = new Db(cfg.DATABASE_URL, log);

// In production the runtime login must be least-privilege (not the superuser, not the schema owner): audit F11.
if (cfg.NODE_ENV === 'production') {
  const violations = await leastPrivilegeViolations(db);
  if (violations.length && !cfg.DB_ALLOW_PRIVILEGED_ROLE) {
    log.fatal(
      { violations },
      'DATABASE_URL uses an over-privileged role; use the tgvl_app login (deploy/postgres/roles.sql) or set DB_ALLOW_PRIVILEGED_ROLE=true for non-production use',
    );
    process.exit(1);
  }
  if (violations.length) log.warn({ violations }, 'running with an over-privileged database role (DB_ALLOW_PRIVILEGED_ROLE=true)');
}

// Refuse to start against an un-migrated database (migrations are an explicit, separately-privileged step).
const applied = await db.query<{ version: string }>('SELECT version FROM schema_migrations').then(
  (r) => new Set(r.rows.map((x) => x.version)),
  () => new Set<string>(),
);
const pending = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && !applied.has(f));
if (pending.length) {
  log.fatal({ pending }, 'database has pending migrations; run `pnpm db:migrate` first');
  process.exit(1);
}

if (!cfg.DATA_ENCRYPTION_KEY_REF || !cfg.ADMIN_TOKEN_SECRET_REF) {
  log.fatal('DATA_ENCRYPTION_KEY_REF and ADMIN_TOKEN_SECRET_REF are required (run `pnpm dev:secrets` for local development)');
  process.exit(1);
}
const crypto = new DataCrypto(new Envelope(parseKeyRing(resolveSecret(cfg.DATA_ENCRYPTION_KEY_REF))));
const adminTokens = resolveSecret(cfg.ADMIN_TOKEN_SECRET_REF)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (adminTokens.some((t) => t.length < 32)) {
  log.fatal('admin tokens must be at least 32 characters');
  process.exit(1);
}

// ---- adapters: explicit, never silently faked ------------------------------------------------------------------------
let messaging: MessagingPort;
let gateway: import('./infrastructure/telegram/gramjs-gateway.js').GramjsMessaging | null = null;
if (cfg.MESSAGING_ADAPTER === 'telegram') {
  const { GramjsMessaging } = await import('./infrastructure/telegram/gramjs-gateway.js');
  const gw = new GramjsMessaging({
    apiId: Number(cfg.TELEGRAM_API_ID),
    apiHash: cfg.TELEGRAM_API_HASH!,
    sessionSecret: resolveSecret(cfg.TELEGRAM_SESSION_SECRET_REF!),
    log,
  });
  messaging = gw;
  gateway = gw;
} else if (cfg.MESSAGING_ADAPTER === 'fake') {
  log.warn('MESSAGING_ADAPTER=fake: messages are NOT sent anywhere (development only)');
  messaging = new FakeMessaging();
} else {
  log.warn('MESSAGING_ADAPTER=disabled: owner messages and reminders cannot be delivered');
  messaging = new DisabledMessaging();
}

let callAdapter: TelegramCallAdapter;
if (cfg.CALL_ADAPTER === 'ntgcalls') {
  if (!gateway) {
    log.fatal('CALL_ADAPTER=ntgcalls requires MESSAGING_ADAPTER=telegram: calls share the one Telegram client that owns the assistant session');
    process.exit(1);
  }
  const { NtgcallsCallAdapter } = await import('./modules/calls/ntgcalls/adapter.js');
  const { createNtgcallsMedia, ntgcallsProtocol } = await import('./infrastructure/telegram/ntgcalls-media.js');
  // Even a real adapter is wrapped: the evidence artifact (bound to this build, produced by this adapter) decides whether it may dial.
  callAdapter = new EvidenceGatedCallAdapter(
    new NtgcallsCallAdapter({
      transport: gateway.callTransport(ntgcallsProtocol()),
      media: createNtgcallsMedia,
      buildFingerprint: cfg.BUILD_FINGERPRINT,
    }),
    () => deriveCapabilities(cfg.CALL_FEASIBILITY_EVIDENCE_PATH, cfg.BUILD_FINGERPRINT),
    cfg.OWNER_TELEGRAM_USER_ID ?? null,
  );
  log.warn('CALL_ADAPTER=ntgcalls: adapter loaded; dialing stays refused until the evidence artifact validates for this build');
} else if (cfg.CALL_ADAPTER === 'fake') {
  log.warn('CALL_ADAPTER=fake: no real calls are possible (development only)');
  callAdapter = new FakeCallAdapter();
} else callAdapter = new DisabledCallAdapter(cfg.BUILD_FINGERPRINT);

if (cfg.TEXT_AI_ADAPTER === 'openai') {
  log.fatal('TEXT_AI_ADAPTER=openai is not implemented in this build; use "rules". (OpenAI docs could not be verified when this was written.)');
  process.exit(1);
}

const derive = () => deriveCapabilities(cfg.CALL_FEASIBILITY_EVIDENCE_PATH, cfg.BUILD_FINGERPRINT);

// The conversation layer for calls to the owner: an AI voice session (never defaulted; config validation requires a provider and model).
let sessionRunner: import('./modules/calls/orchestrator.js').CallSessionRunner | undefined;
if (cfg.CALL_ADAPTER === 'ntgcalls' && cfg.AI_VOICE_PROVIDER) {
  const { OwnerCallRunner } = await import('./modules/calls/conversation/owner-call-runner.js');
  const { TaskService } = await import('./modules/tasks/tasks.service.js');
  const { ContactService } = await import('./modules/contacts/contacts.service.js');
  const { ContactCallService } = await import('./modules/calls/contact-calls.service.js');
  const { AuthorizationService } = await import('./modules/calls/authorizations.service.js');
  const { ReminderService } = await import('./modules/scheduling/reminders.service.js');
  const { GeminiLiveLink } = await import('./infrastructure/gemini/live.js');
  const { OpenAiRealtimeLink } = await import('./infrastructure/openai/realtime.js');
  const { VoiceLabTts } = await import('./infrastructure/voicelab/tts.js');
  const { VoiceLabMouthLink } = await import('./infrastructure/voicelab/mouth-link.js');
  const { VOICE_TEXT_OUTPUT_RULE } = await import('./modules/calls/conversation/language-rule.js');
  const voicelab = cfg.TTS_PROVIDER === 'voicelab';
  // VoiceLab only speaks: the model that listens and decides answers in text (tools, memory and negotiation limits work as before).
  const voiced = <T extends import('./infrastructure/voicelab/mouth-link.js').TextBrain>(brain: T) =>
    new VoiceLabMouthLink(
      brain,
      new VoiceLabTts({
        apiKey: cfg.VOICELAB_API_KEY!,
        voiceId: cfg.VOICELAB_VOICE_ID!,
        baseUrl: cfg.VOICELAB_BASE_URL,
        model: cfg.VOICELAB_TTS_MODEL,
        speed: cfg.VOICELAB_SPEED,
      }),
      { log: (line) => log.debug({ call: true }, line) },
    );
  const makeOpenAi = (o: ConstructorParameters<typeof OpenAiRealtimeLink>[0]) =>
    voicelab
      ? voiced(new OpenAiRealtimeLink({ ...o, instructions: `${o.instructions}\n${VOICE_TEXT_OUTPUT_RULE}`, textOutput: true }))
      : new OpenAiRealtimeLink(o);
  const makeGemini = (o: ConstructorParameters<typeof GeminiLiveLink>[0]) =>
    voicelab ? voiced(new GeminiLiveLink({ ...o, instructions: `${o.instructions}\n${VOICE_TEXT_OUTPUT_RULE}`, textOutput: true })) : new GeminiLiveLink(o);
  const makeLink = ({ instructions, tools }: { instructions: string; tools: import('./modules/calls/audio/realtime-bridge.js').ToolDeclaration[] }) =>
    cfg.AI_VOICE_PROVIDER === 'gemini'
      ? makeGemini({
          apiKey: cfg.GEMINI_API_KEY!,
          model: cfg.GEMINI_LIVE_MODEL!,
          voice: cfg.GEMINI_VOICE,
          instructions,
          tools,
          textMode: cfg.GEMINI_TEXT_MODE,
          googleSearch: cfg.GEMINI_GOOGLE_SEARCH,
          languageCode: cfg.GEMINI_LANGUAGE_CODE,
          ...(cfg.GEMINI_DEBUG ? { debug: (line: string) => log.info({ gemini: true }, line.slice(0, 200)) } : {}),
        })
      : makeOpenAi({
          apiKey: cfg.OPENAI_API_KEY!,
          model: cfg.OPENAI_REALTIME_MODEL!,
          voice: cfg.OPENAI_VOICE,
          instructions,
          tools,
          dialect: cfg.OPENAI_REALTIME_DIALECT,
          transcriptionModel: cfg.OPENAI_TRANSCRIPTION_MODEL,
        });
  const { MemoryService } = await import('./modules/memory/memory.service.js');
  const { RecallService } = await import('./modules/memory/recall.js');
  const recall = new RecallService(crypto, new MemoryService(crypto));
  const ownerRunner = new OwnerCallRunner({
    db,
    recall,
    tasks: new TaskService(crypto),
    reminders: new ReminderService(db, crypto, systemClock),
    clock: systemClock,
    callRemindersLive: cfg.CALLS_ENABLED,
    contacts: new ContactService(crypto),
    contactCalls: cfg.CALLS_ENABLED ? new ContactCallService(new AuthorizationService(db, systemClock, crypto), systemClock) : undefined,
    costUsdPerMinute: cfg.AI_VOICE_COST_USD_PER_MINUTE,
    log: (line) => (/^(realtime error|error): /.test(line) ? log.warn : log.debug).call(log, { call: true }, line.slice(0, 300)), // provider errors must be visible; transcripts stay at debug // transcripts are never persisted or logged above debug level
    makeLink,
  });
  const { ContactCallRunner, RoutingCallRunner } = await import('./modules/calls/conversation/contact-call-runner.js');
  const contactRunner = new ContactCallRunner({
    db,
    tasks: new TaskService(crypto),
    memory: new (await import('./modules/memory/memory.service.js')).MemoryService(crypto),
    clock: systemClock,
    makeLink,
    costUsdPerMinute: cfg.AI_VOICE_COST_USD_PER_MINUTE,
    log: (line) => (/^(realtime error|error): /.test(line) ? log.warn : log.debug).call(log, { call: true }, line.slice(0, 300)), // provider errors must be visible; transcripts stay at debug
    onDone: (d) =>
      (d.errors.length || !('callFramesOut' in d.stats) || d.stats.callFramesOut === 0 ? log.warn : log.info).call(
        log,
        { contactCall: d },
        'contact call conversation ended',
      ),
  });
  sessionRunner = new RoutingCallRunner(db, ownerRunner, contactRunner);
  if (cfg.AI_VOICE_PROVIDER === 'gemini')
    log.warn(
      "contact calls send the contact's voice to Gemini; on the free tier Google may use that data to improve its products — use a paid tier before calling contacts",
    );
  log.warn({ provider: cfg.AI_VOICE_PROVIDER }, 'owner-call conversation layer loaded; calls still require CALLS_ENABLED and valid evidence');
}

let transcription: import('./application/ports.js').TranscriptionPort | undefined;
if (cfg.GEMINI_API_KEY && cfg.GEMINI_TRANSCRIPTION_MODEL) {
  const { GeminiTranscription } = await import('./infrastructure/gemini/transcribe.js');
  transcription = new GeminiTranscription({ apiKey: cfg.GEMINI_API_KEY, model: cfg.GEMINI_TRANSCRIPTION_MODEL });
  log.warn('voice notes are transcribed by Gemini (not live verified); on the free tier Google may use the audio to improve its products');
}

let textFallback: import('./application/ports.js').IntentFallbackPort | undefined;
if (cfg.GEMINI_API_KEY && cfg.GEMINI_TEXT_MODEL && cfg.TEXT_AI_ADAPTER === 'rules') {
  const { GeminiTextFallback } = await import('./infrastructure/gemini/text.js');
  textFallback = new GeminiTextFallback({ apiKey: cfg.GEMINI_API_KEY, model: cfg.GEMINI_TEXT_MODEL });
  log.warn(
    'free-form text understanding is on (Gemini, not live verified): text the rules do not recognise is sent to Gemini; on the free tier Google may use it to improve its products',
  );
}

const app = buildContainer({
  ...(transcription ? { transcription } : {}),
  ...(textFallback ? { textFallback } : {}),
  ...(textFallback && 'compose' in textFallback ? { composer: textFallback as unknown as import('./application/ports.js').MessageComposerPort } : {}),
  onFallbackError: (e) => log.warn({ err: e.message }, 'free-form text understanding failed; the message was treated as unknown'),
  onVoiceError: (e) => log.warn({ err: e.message }, 'voice note could not be transcribed'),
  ...(sessionRunner ? { sessionRunner } : {}),
  ...(gateway ? { peers: gateway } : {}),
  db,
  crypto,
  clock: systemClock,
  messaging,
  callAdapter,
  deriveCapabilities: derive,
  callsEnabled: cfg.CALLS_ENABLED,
  textAiDisabled: cfg.TEXT_AI_ADAPTER === 'disabled',
  workerId: `worker-${process.pid}`,
  ...(cfg.DAILY_AI_BUDGET_USD ? { dailyCapMicroUsd: Math.round(cfg.DAILY_AI_BUDGET_USD * 1_000_000) } : {}),
});

// The configured owner must match the database BEFORE any adapter or worker starts (audit F18).
const owners = (
  await db.query<{ id: string; timezone: string; telegram_user_id: string }>('SELECT id, timezone, telegram_user_id FROM owners ORDER BY created_at')
).rows;
const ownerProblem = verifyConfiguredOwner({ production: cfg.NODE_ENV === 'production', configured: cfg.OWNER_TELEGRAM_USER_ID, owners });
if (ownerProblem) {
  log.fatal(ownerProblem);
  process.exit(1);
}
const owner = owners[0];
if (owner && cfg.DAILY_AI_BUDGET_USD) {
  await ensureDailyBudget(db, owner.id, DateTime.now().setZone(owner.timezone).toFormat('yyyy-LL-dd'), Math.round(cfg.DAILY_AI_BUDGET_USD * 1_000_000));
}
if (gateway) {
  const acct = (
    await db.query<{ id: string; assistant_telegram_user_id: string; owner_telegram: string }>(
      'SELECT a.id, a.assistant_telegram_user_id, o.telegram_user_id AS owner_telegram FROM telegram_accounts a JOIN owners o ON o.id = a.owner_id ORDER BY a.created_at LIMIT 1',
    )
  ).rows[0];
  if (!acct) {
    log.fatal('MESSAGING_ADAPTER=telegram but no owner/account is bootstrapped; run `pnpm bootstrap:owner`');
    process.exit(1);
  }
  await gateway.start({
    intake: app.intake,
    accountId: acct.id,
    expectedAssistantId: acct.assistant_telegram_user_id,
    ownerTelegramId: acct.owner_telegram,
    watermarks: new DbWatermarkStore(db, () => new Date()),
    markActive: async () => {
      await db.query(`UPDATE telegram_accounts SET status='active' WHERE id=$1 AND status='unprovisioned'`, [acct.id]);
    },
  });
  log.info('telegram gateway started (identity verified)');
}
if (owner) {
  // Startup catch-up only: every completed sweep schedules its own successor in the same transaction (audit F09).
  const { ensureRetentionScheduled } = await import('./modules/retention/schedule.js');
  await ensureRetentionScheduled(db, owner.id, new Date());
}
const sealed = await sealLegacyPlaintext(db, crypto);
if (Object.values(sealed).some(Boolean)) log.info(sealed, 'sealed plaintext copies written before field-level sealing existed');
const rec = await app.recoverCalls();
if (rec.recovered) log.warn({ recovered: rec.recovered }, 'reconciled calls orphaned by a previous crash (no redial performed)');

const server = await buildServer({
  app,
  log,
  adminTokens,
  runtime: {
    messagingAdapter: cfg.MESSAGING_ADAPTER,
    interpreterAdapter: cfg.TEXT_AI_ADAPTER,
    callAdapter: cfg.CALL_ADAPTER,
    evidencePath: cfg.CALL_FEASIBILITY_EVIDENCE_PATH ?? null,
    buildFingerprint: cfg.BUILD_FINGERPRINT,
    transcription: !!transcription,
    callsEnabled: cfg.CALLS_ENABLED,
    messagingStatus: () => (gateway ? gateway.status() : { adapter: cfg.MESSAGING_ADAPTER }),
  },
});
await server.listen({ host: cfg.HTTP_HOST, port: cfg.HTTP_PORT });
log.info(
  {
    host: cfg.HTTP_HOST,
    port: cfg.HTTP_PORT,
    mode: derive().productionCallingAllowed
      ? 'calling-evidence-present'
      : derive().ownerCallingAllowed
        ? 'owner-calling-evidence-present'
        : 'degraded-text-only',
  },
  'assistant started',
);

// Say plainly WHY calling is on or off. "degraded-text-only" alone does not tell the owner which condition is missing.
{
  const caps = derive();
  const problems: string[] = [];
  if (!cfg.CALLS_ENABLED) problems.push('CALLS_ENABLED is not true');
  if (cfg.CALL_ADAPTER !== 'ntgcalls') problems.push(`CALL_ADAPTER is "${cfg.CALL_ADAPTER}" (needs ntgcalls)`);
  if (!cfg.CALL_FEASIBILITY_EVIDENCE_PATH) problems.push('CALL_FEASIBILITY_EVIDENCE_PATH is not set');
  if (!caps.ownerCallingAllowed) problems.push(...caps.reasons.filter((r) => !/^G0-[DEF]: not recorded/.test(r)));
  if (!cfg.AI_VOICE_PROVIDER) problems.push('AI_VOICE_PROVIDER is not set (a call would have nobody to talk)');
  // BUILD_FINGERPRINT is supplied by the deployment; if the call-path sources in this checkout no longer hash to it, the evidence was
  // recorded for different code. Say so (a warning, not a refusal: only the operator can decide to re-record).
  try {
    const actual = computeBuildFingerprint(fileURLToPath(new URL('../../../', import.meta.url)));
    if (cfg.CALLS_ENABLED && actual !== cfg.BUILD_FINGERPRINT)
      log.warn(
        { configured: cfg.BUILD_FINGERPRINT.slice(0, 12), actual: actual.slice(0, 12) },
        'the call-path code in this checkout differs from BUILD_FINGERPRINT: the live evidence was recorded for other code. Run `pnpm evidence:production` and re-record the 5-minute call if the call path changed',
      );
  } catch {
    /* not a source checkout (e.g. a container image): the deployment pins the fingerprint */
  }
  const state = problems.length ? 'owner calls are OFF' : 'owner calls are ON (the durable kill switch is still checked on every dial: GET /v1/capabilities)';
  (problems.length ? log.warn : log.info).call(
    log,
    {
      callsEnabled: cfg.CALLS_ENABLED,
      callAdapter: cfg.CALL_ADAPTER,
      voiceProvider: cfg.AI_VOICE_PROVIDER ?? null,
      ownerCallingAllowed: caps.ownerCallingAllowed,
      evidenceBoundToThisBuild: caps.evidenceArtifact !== null,
      buildFingerprint: cfg.BUILD_FINGERPRINT.slice(0, 12),
      because: problems,
    },
    state,
  );
}

// ---- worker loop --------------------------------------------------------------------------------------------------------
// Independent, non-overlapping lanes: a long call can never delay reminders or text delivery (audit F08).
let stopping = false;
const lanes = (['jobs', 'calls', 'outbox'] as const).map((name) =>
  startLane({
    name,
    intervalMs: 1000,
    run: () => app.tickLane(name),
    onError: (e, lane) => log.error({ err: e.message, lane }, 'worker tick failed'),
  }),
);

async function shutdown(sig: string) {
  if (stopping) return;
  stopping = true;
  log.info({ sig }, 'draining');
  const hard = setTimeout(() => process.exit(1), 30_000); // spec §11.2: shut down within 30 s
  hard.unref();
  // Stop claiming, ask every live call to end, and let supervisors persist their final or uncertain state (restart recovery
  // reconciles anything still unsettled and never redials).
  const drained = await drainWorker({ lanes, registry: app.registry, deadlineMs: 20_000 });
  if (drained.endedCalls || drained.timedOut) log.warn(drained, 'drained with live calls / deadline reached');
  await server.close();
  await gateway?.stop().catch(() => undefined);
  await db.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
