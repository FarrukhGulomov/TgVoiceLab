import { readdirSync } from 'node:fs';
import { DateTime } from 'luxon';
import { loadConfig } from './bootstrap/config.js';
import { buildContainer } from './bootstrap/container.js';
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
import { DisabledCallAdapter } from './modules/calls/adapters.js';
import { deriveCapabilities } from './modules/calls/capability-evidence.js';
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
  log.fatal(
    'CALL_ADAPTER=ntgcalls: the production call adapter is NOT implemented in this build. Phase 0 live gates must pass first (see docs/research/telegram-private-calls.md).',
  );
  process.exit(1);
} else if (cfg.CALL_ADAPTER === 'fake') {
  log.warn('CALL_ADAPTER=fake: no real calls are possible (development only)');
  callAdapter = new FakeCallAdapter();
} else callAdapter = new DisabledCallAdapter(cfg.BUILD_FINGERPRINT);

if (cfg.TEXT_AI_ADAPTER === 'openai') {
  log.fatal('TEXT_AI_ADAPTER=openai is not implemented in this build; use "rules". (OpenAI docs could not be verified when this was written.)');
  process.exit(1);
}

const derive = () => deriveCapabilities(cfg.CALL_FEASIBILITY_EVIDENCE_PATH, cfg.BUILD_FINGERPRINT);
const app = buildContainer({
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
    transcription: false,
  },
});
await server.listen({ host: cfg.HTTP_HOST, port: cfg.HTTP_PORT });
log.info(
  { host: cfg.HTTP_HOST, port: cfg.HTTP_PORT, mode: derive().productionCallingAllowed ? 'calling-evidence-present' : 'degraded-text-only' },
  'assistant started',
);

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
