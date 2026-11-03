import { z } from 'zod';
import { TelegramUserIdSchema } from '@tgvl/contracts';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const emptyToUndef = (v: unknown) => (v === '' ? undefined : v);
/**
 * TTS_PROVIDER / STT_PROVIDER pick VoiceLab. Writing the model that already speaks and listens (gemini, openai) or "none" means "no separate
 * provider" and is read as unset; the case and stray spaces of a hand-edited .env do not matter either.
 */
const NO_SEPARATE_PROVIDER = new Set(['', 'gemini', 'openai', 'native', 'none', 'off', 'default']);
const providerChoice = (v: unknown): unknown => {
  if (typeof v !== 'string') return v;
  const t = v.trim().toLowerCase();
  return NO_SEPARATE_PROVIDER.has(t) ? undefined : t;
};
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
    GEMINI_API_KEY: opt(z.string()),
    GEMINI_LIVE_MODEL: opt(z.string()),
    GEMINI_VOICE: opt(z.string()),
    /** Model for voice-note transcription (Gemini generateContent). Never defaulted; with GEMINI_API_KEY it turns voice notes on. */
    GEMINI_TRANSCRIPTION_MODEL: opt(z.string()),
    /** Model for free-form text understanding (Gemini generateContent). Never defaulted; with GEMINI_API_KEY it enables the fallback for text the rules did not recognise. */
    GEMINI_TEXT_MODEL: opt(z.string()),
    /** Which AI voice provider talks on calls. Models are never defaulted. */
    AI_VOICE_PROVIDER: z.enum(['openai', 'gemini']).optional(),
    OPENAI_REALTIME_DIALECT: z.enum(['ga', 'beta']).default('ga'),
    OPENAI_TRANSCRIPTION_MODEL: opt(z.string()),
    /** With TTS_PROVIDER=voicelab on Gemini: `transcript` (default) drops the model's audio and voices its transcript (works with native-audio models); `modality` asks for TEXT output (needs a Live model that supports it). */
    GEMINI_TEXT_OUTPUT: z.enum(['transcript', 'modality']).default('transcript'),
    /** Turn-taking tuning for Gemini Live (unset = defaults): how long a pause ends the caller's turn, and the start/end-of-speech sensitivity. */
    GEMINI_VAD_SILENCE_MS: opt(z.coerce.number().int().min(100).max(5000)),
    GEMINI_VAD_PREFIX_MS: opt(z.coerce.number().int().min(0).max(1000)),
    GEMINI_VAD_START: opt(z.enum(['low', 'high'])),
    GEMINI_VAD_END: opt(z.enum(['low', 'high'])),
    GEMINI_TEXT_MODE: z.enum(['realtime', 'client_content']).default('realtime'),
    GEMINI_GOOGLE_SEARCH: bool.default(false),
    GEMINI_LANGUAGE_CODE: opt(z.string()),
    /** Log the Gemini Live session's protocol events (setup, audio counts, tool calls, close codes) at info level. No speech content is logged. */
    GEMINI_DEBUG: bool.default(false),
    /** How long what a call taught the assistant about a contact (summary, offers, notes) is remembered. 0 = forever. Call reports themselves are deleted after 30 days; memories derived from them follow this setting instead of outliving them silently. Style lessons (no personal data) are kept. */
    CALL_MEMORY_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(180),
    /** Estimated provider cost of a live call, in USD per minute. Used only to settle the call budget; unset: a connected call is settled at its full reservation (an unknown cost never counts as free). */
    AI_VOICE_COST_USD_PER_MINUTE: opt(z.coerce.number().positive().max(100)),
    /** Who speaks on calls. Unset: the AI voice provider's own voice. `voicelab`: VoiceLab's Uzbek voice (the listening/thinking model answers in text). Needs AI_VOICE_PROVIDER=openai or gemini (the model answers in text; for gemini the Live model must support TEXT output). */
    TTS_PROVIDER: z.preprocess(providerChoice, z.enum(['voicelab', 'elevenlabs']).optional()),
    /** Also speak the reply to an owner's voice note (needs TTS_PROVIDER=voicelab and `ffmpeg`). */
    VOICE_REPLIES: bool.default(true),
    /** VoiceLab voice: say a short "Xo'p." the moment the caller stops talking, before the model's answer is ready. */
    VOICELAB_FILLER: bool.default(true),
    /** Streaming synthesis (WebSocket /v1/tts/stream): audio is played while it is still being produced. Needs a key with tts:realtime. The streaming endpoint has no model choice (VOICELAB_TTS_MODEL applies to the REST fallback only). Off by default. */
    VOICELAB_TTS_STREAM: bool.default(false),
    VOICELAB_TTS_STREAM_URL: opt(z.string()),
    /** Speech recognition. Unset: the AI voice model hears the call itself (and Gemini transcribes voice notes). `voicelab`: VoiceLab's Uzbek recogniser (key needs stt:realtime for calls, stt:write + stt:read for voice notes). */
    STT_PROVIDER: z.preprocess(providerChoice, z.enum(['voicelab', 'elevenlabs']).optional()),
    /** ElevenLabs (TTS_PROVIDER=elevenlabs and/or STT_PROVIDER=elevenlabs). Models and the voice are never defaulted: check which model speaks Uzbek on your plan. */
    ELEVENLABS_API_KEY: opt(z.string()),
    ELEVENLABS_VOICE_ID: opt(z.string()),
    /** Text-to-speech model id (e.g. eleven_v3, eleven_flash_v2_5). */
    ELEVENLABS_TTS_MODEL: opt(z.string()),
    /** Live recognition model id for calls (e.g. scribe_v2_realtime). */
    ELEVENLABS_STT_MODEL: opt(z.string()),
    /** File recognition model id for the owner's voice notes (e.g. scribe_v2). Unset: voice notes keep using the other transcription (Gemini). */
    ELEVENLABS_STT_FILE_MODEL: opt(z.string()),
    /** ISO language of the speech to recognise and of the voice (ISO-639-1). */
    ELEVENLABS_LANGUAGE_CODE: z.string().min(2).max(8).default('uz'),
    ELEVENLABS_SPEED: opt(z.coerce.number().min(0.7).max(1.2)),
    ELEVENLABS_STABILITY: opt(z.coerce.number().min(0).max(1)),
    ELEVENLABS_STT_CALLS: bool.default(true),
    /** With STT_PROVIDER=voicelab: use it for live calls (needs TTS_PROVIDER=voicelab: the model then only reads and writes text) and for the owner's voice notes. */
    VOICELAB_STT_CALLS: bool.default(true),
    VOICELAB_STT_NOTES: bool.default(true),
    /** Live recognition endpoint; default is derived from VOICELAB_BASE_URL (wss://api.voicelab.uz/v1/stt/stream). */
    VOICELAB_STT_URL: opt(z.string().regex(/^wss?:\/\//)),
    VOICELAB_STT_LANGUAGE: z.string().min(2).max(8).default('uz'),
    /** Silence (ms) that ends the caller's utterance and commits it to the recogniser: shorter = faster answers but people get cut off. */
    VOICELAB_STT_SILENCE_MS: z.coerce.number().int().min(250).max(2000).default(600),
    /** RMS level of the caller's audio that counts as speech (raise on a noisy line). */
    VOICELAB_STT_LEVEL: z.coerce.number().int().min(100).max(3000).default(450),
    VOICELAB_API_KEY: opt(z.string()),
    /** The voice's id from `pnpm voicelab:check` (e.g. the one named Nozima). */
    VOICELAB_VOICE_ID: opt(z.string()),
    VOICELAB_BASE_URL: opt(z.string().url()),
    /** Sent as `model_id` only when set (the web studio offers "Lison v1"; the id is on docs.voicelab.uz). */
    VOICELAB_TTS_MODEL: opt(z.string()),
    VOICELAB_SPEED: opt(z.coerce.number().min(0.5).max(2)),
    DATA_ENCRYPTION_KEY_REF: opt(z.string()),
    ADMIN_TOKEN_SECRET_REF: opt(z.string()),
    /** Escape hatch for single-login development databases. Never set in production deployments (audit F11). */
    DB_ALLOW_PRIVILEGED_ROLE: bool.default(false),
    CALLS_ENABLED: bool.default(false),
    /** Answer calls the OWNER makes to the assistant's Telegram account (phase 1 of incoming calls; everyone else is declined as busy). Needs CALL_ADAPTER=ntgcalls and CALLS_ENABLED. */
    ANSWER_OWNER_CALLS: bool.default(false),
    CALL_ADAPTER: z.enum(['disabled', 'ntgcalls', 'fake']).default('disabled'),
    MESSAGING_ADAPTER: z.enum(['disabled', 'telegram', 'fake']).default('disabled'),
    TEXT_AI_ADAPTER: z.enum(['disabled', 'rules', 'openai']).default('rules'),
    CALL_FEASIBILITY_EVIDENCE_PATH: opt(z.string()),
    /** Not implemented: raw audio and full transcripts are never stored. The switches exist only so that turning them on is refused instead of silently ignored. */
    RAW_AUDIO_RECORDING_ENABLED: bool.default(false),
    FULL_TRANSCRIPT_RETENTION_ENABLED: bool.default(false),
    /** The owner's first name, used in the assistant's greetings and prompts. Unset: the assistant addresses the owner without a name. */
    OWNER_NAME: opt(z.string().min(1).max(40)),
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
    if (e.TTS_PROVIDER === 'elevenlabs') {
      if (!e.ELEVENLABS_API_KEY) bad('ELEVENLABS_API_KEY', 'TTS_PROVIDER=elevenlabs requires ELEVENLABS_API_KEY');
      if (!e.ELEVENLABS_VOICE_ID) bad('ELEVENLABS_VOICE_ID', 'TTS_PROVIDER=elevenlabs requires ELEVENLABS_VOICE_ID (a voice id from your ElevenLabs account)');
      if (!e.ELEVENLABS_TTS_MODEL) bad('ELEVENLABS_TTS_MODEL', 'TTS_PROVIDER=elevenlabs requires ELEVENLABS_TTS_MODEL (no model is hardcoded)');
      if (!e.AI_VOICE_PROVIDER)
        bad('TTS_PROVIDER', 'the ElevenLabs voice needs AI_VOICE_PROVIDER=openai or gemini (that model listens and answers in text, ElevenLabs speaks)');
    }
    if (e.STT_PROVIDER === 'elevenlabs') {
      if (!e.ELEVENLABS_API_KEY) bad('ELEVENLABS_API_KEY', 'STT_PROVIDER=elevenlabs requires ELEVENLABS_API_KEY');
      if (e.ELEVENLABS_STT_CALLS && !e.ELEVENLABS_STT_MODEL)
        bad('ELEVENLABS_STT_MODEL', 'live-call recognition by ElevenLabs requires ELEVENLABS_STT_MODEL (e.g. scribe_v2_realtime)');
      if (e.ELEVENLABS_STT_CALLS && e.CALLS_ENABLED && !e.TTS_PROVIDER)
        bad(
          'STT_PROVIDER',
          'live-call recognition by ElevenLabs needs TTS_PROVIDER (voicelab or elevenlabs): the thinking model then works in text only; set ELEVENLABS_STT_CALLS=false to use it for voice notes only',
        );
    }
    if (e.TTS_PROVIDER === 'voicelab') {
      if (!e.VOICELAB_API_KEY) bad('VOICELAB_API_KEY', 'TTS_PROVIDER=voicelab requires VOICELAB_API_KEY');
      if (!e.VOICELAB_VOICE_ID) bad('VOICELAB_VOICE_ID', 'TTS_PROVIDER=voicelab requires VOICELAB_VOICE_ID (list voices with `pnpm voicelab:check`)');
      if (!e.AI_VOICE_PROVIDER)
        bad('TTS_PROVIDER', 'the VoiceLab voice needs AI_VOICE_PROVIDER=openai or gemini (that model listens and answers in text, VoiceLab speaks)');
    }
    if (e.STT_PROVIDER === 'voicelab') {
      if (!e.VOICELAB_API_KEY) bad('VOICELAB_API_KEY', 'STT_PROVIDER=voicelab requires VOICELAB_API_KEY');
      if (e.VOICELAB_STT_CALLS && e.CALLS_ENABLED && !e.TTS_PROVIDER)
        bad(
          'STT_PROVIDER',
          'live-call recognition by VoiceLab needs TTS_PROVIDER (voicelab or elevenlabs): the thinking model then works in text only; set VOICELAB_STT_CALLS=false to use it for voice notes only',
        );
    }
    if (e.RAW_AUDIO_RECORDING_ENABLED) bad('RAW_AUDIO_RECORDING_ENABLED', 'raw audio recording is not implemented; audio is never stored');
    if (e.FULL_TRANSCRIPT_RETENTION_ENABLED)
      bad('FULL_TRANSCRIPT_RETENTION_ENABLED', 'full transcript retention is not implemented; transcripts are never stored');
    if (e.NODE_ENV === 'production' && (e.LOG_LEVEL === 'debug' || e.LOG_LEVEL === 'trace'))
      bad('LOG_LEVEL', 'debug and trace are refused in production: they can carry conversation content');
    if (e.ANSWER_OWNER_CALLS && (!e.CALLS_ENABLED || e.CALL_ADAPTER !== 'ntgcalls'))
      bad('ANSWER_OWNER_CALLS', 'answering the owner needs CALLS_ENABLED=true and CALL_ADAPTER=ntgcalls');
    if (e.CALLS_ENABLED) {
      if (e.CALL_ADAPTER === 'disabled') bad('CALL_ADAPTER', 'CALLS_ENABLED=true requires a real call adapter');
      if (!e.CALL_FEASIBILITY_EVIDENCE_PATH) bad('CALL_FEASIBILITY_EVIDENCE_PATH', 'calling requires a feasibility evidence artifact');
      if (!e.DAILY_AI_BUDGET_USD) bad('DAILY_AI_BUDGET_USD', 'calling requires a daily budget');
      if (!e.OWNER_TELEGRAM_USER_ID) bad('OWNER_TELEGRAM_USER_ID', 'calling requires a bootstrapped owner id');
      // A call with nobody to talk would just hang up: the conversation layer must be configured too.
      if (e.CALL_ADAPTER === 'ntgcalls') {
        if (!e.AI_VOICE_PROVIDER) bad('AI_VOICE_PROVIDER', 'calling with CALL_ADAPTER=ntgcalls requires an AI voice provider (openai or gemini)');
        else if (e.AI_VOICE_PROVIDER === 'openai' && (!e.OPENAI_API_KEY || !e.OPENAI_REALTIME_MODEL))
          bad('OPENAI_REALTIME_MODEL', 'AI_VOICE_PROVIDER=openai requires OPENAI_API_KEY and OPENAI_REALTIME_MODEL (no model is hardcoded)');
        else if (e.AI_VOICE_PROVIDER === 'gemini' && (!e.GEMINI_API_KEY || !e.GEMINI_LIVE_MODEL))
          bad('GEMINI_LIVE_MODEL', 'AI_VOICE_PROVIDER=gemini requires GEMINI_API_KEY and GEMINI_LIVE_MODEL (no model is hardcoded)');
      }
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
