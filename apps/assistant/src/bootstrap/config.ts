import { z } from 'zod';
import { TelegramUserIdSchema } from '@tgvl/contracts';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const emptyToUndef = (v: unknown) => (v === '' ? undefined : v);
const opt = <T extends z.ZodType>(s: T) => z.preprocess(emptyToUndef, s.optional());

/** Environment contract. Secrets are *references* (`file:/path` or `env:NAME`), never literal values. */
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.string().min(1),
    OWNER_TELEGRAM_USER_ID: opt(TelegramUserIdSchema),
    OWNER_TIMEZONE: z.string().default('Asia/Samarkand'),
    TELEGRAM_API_ID: opt(z.string().regex(/^\d+$/)),
    TELEGRAM_API_HASH: opt(z.string().min(8)),
    TELEGRAM_SESSION_SECRET_REF: opt(z.string()),
    OPENAI_API_KEY: opt(z.string()),
    OPENAI_TEXT_MODEL: opt(z.string()),
    OPENAI_REALTIME_MODEL: opt(z.string()),
    OPENAI_VOICE: opt(z.string()),
    DATA_ENCRYPTION_KEY_REF: opt(z.string()),
    ADMIN_TOKEN_SECRET_REF: opt(z.string()),
    /** Escape hatch for single-login development databases. Never set in production deployments (audit F11). */
    DB_ALLOW_PRIVILEGED_ROLE: bool.default(false),
    CALLS_ENABLED: bool.default(false),
    CALL_ADAPTER: z.enum(['disabled', 'ntgcalls', 'fake']).default('disabled'),
    MESSAGING_ADAPTER: z.enum(['disabled', 'telegram', 'fake']).default('disabled'),
    TEXT_AI_ADAPTER: z.enum(['disabled', 'rules', 'openai']).default('rules'),
    CALL_FEASIBILITY_EVIDENCE_PATH: opt(z.string()),
    MEDIA_SOCKET_PATH: z.string().default('/run/assistant/media.sock'),
    RAW_AUDIO_RECORDING_ENABLED: bool.default(false),
    FULL_TRANSCRIPT_RETENTION_ENABLED: bool.default(false),
    DAILY_AI_BUDGET_USD: opt(z.coerce.number().positive().max(10000)),
    HTTP_HOST: z.string().default('127.0.0.1'),
    HTTP_PORT: z.coerce.number().int().min(0).max(65535).default(8080),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    BUILD_FINGERPRINT: z.string().default('dev'),
  })
  .superRefine((e, ctx) => {
    const bad = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    const prod = e.NODE_ENV === 'production';
    if (prod) {
      // Fakes may never be selected silently (or at all) in production.
      if (e.CALL_ADAPTER === 'fake') bad('CALL_ADAPTER', 'fake adapter is forbidden in production');
      if (e.MESSAGING_ADAPTER === 'fake') bad('MESSAGING_ADAPTER', 'fake adapter is forbidden in production');
      if (!e.DATA_ENCRYPTION_KEY_REF) bad('DATA_ENCRYPTION_KEY_REF', 'required in production');
      if (!e.ADMIN_TOKEN_SECRET_REF) bad('ADMIN_TOKEN_SECRET_REF', 'required in production');
      if (!e.OWNER_TELEGRAM_USER_ID) bad('OWNER_TELEGRAM_USER_ID', 'required in production');
    }
    if (e.CALLS_ENABLED) {
      if (e.CALL_ADAPTER === 'disabled') bad('CALL_ADAPTER', 'CALLS_ENABLED=true requires a real call adapter');
      if (!e.CALL_FEASIBILITY_EVIDENCE_PATH) bad('CALL_FEASIBILITY_EVIDENCE_PATH', 'calling requires a feasibility evidence artifact');
      if (!e.DAILY_AI_BUDGET_USD) bad('DAILY_AI_BUDGET_USD', 'calling requires a daily budget');
      if (!e.OWNER_TELEGRAM_USER_ID) bad('OWNER_TELEGRAM_USER_ID', 'calling requires a bootstrapped owner id');
    }
    if (e.MESSAGING_ADAPTER === 'telegram') {
      for (const k of ['TELEGRAM_API_ID', 'TELEGRAM_API_HASH', 'TELEGRAM_SESSION_SECRET_REF'] as const)
        if (!e[k]) bad(k, 'required when MESSAGING_ADAPTER=telegram');
    }
    if (e.TEXT_AI_ADAPTER === 'openai' && (!e.OPENAI_API_KEY || !e.OPENAI_TEXT_MODEL)) {
      bad('OPENAI_TEXT_MODEL', 'OPENAI_API_KEY and OPENAI_TEXT_MODEL are required for the openai adapter (no model is hardcoded)');
    }
  });

export type AppConfig = z.infer<typeof EnvSchema>;

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration:\n - ${issues.join('\n - ')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    // Report variable names and messages only — never echo values (they may be secrets).
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  return parsed.data;
}
