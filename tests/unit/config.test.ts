import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../apps/assistant/src/bootstrap/config.js';

const base = { DATABASE_URL: 'postgres://x/y' };

describe('config validation', () => {
  it('defaults are fail-closed: calls off, adapters disabled, Samarkand timezone', () => {
    const c = loadConfig(base);
    expect(c.CALLS_ENABLED).toBe(false);
    expect(c.CALL_ADAPTER).toBe('disabled');
    expect(c.MESSAGING_ADAPTER).toBe('disabled');
    expect(c.RAW_AUDIO_RECORDING_ENABLED).toBe(false);
    expect(c.FULL_TRANSCRIPT_RETENTION_ENABLED).toBe(false);
    expect(c.OWNER_TIMEZONE).toBe('Asia/Samarkand');
    expect(c.HTTP_HOST).toBe('127.0.0.1');
  });

  it('treats empty strings from .env.example placeholders as unset', () => {
    const c = loadConfig({ ...base, OWNER_TELEGRAM_USER_ID: '', OPENAI_API_KEY: '', DAILY_AI_BUDGET_USD: '' });
    expect(c.OWNER_TELEGRAM_USER_ID).toBeUndefined();
    expect(c.DAILY_AI_BUDGET_USD).toBeUndefined();
  });

  it('refuses fake adapters in production', () => {
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        CALL_ADAPTER: 'fake',
        DATA_ENCRYPTION_KEY_REF: 'env:K',
        ADMIN_TOKEN_SECRET_REF: 'env:T',
        OWNER_TELEGRAM_USER_ID: '1',
      }),
    ).toThrow(/fake adapter is forbidden/);
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        MESSAGING_ADAPTER: 'fake',
        DATA_ENCRYPTION_KEY_REF: 'env:K',
        ADMIN_TOKEN_SECRET_REF: 'env:T',
        OWNER_TELEGRAM_USER_ID: '1',
      }),
    ).toThrow(/fake adapter is forbidden/);
  });

  it('a CALLS_ENABLED boolean alone cannot enable calling', () => {
    expect(() => loadConfig({ ...base, CALLS_ENABLED: 'true' })).toThrow(ConfigError);
    try {
      loadConfig({ ...base, CALLS_ENABLED: 'true' });
    } catch (e) {
      const m = (e as ConfigError).issues.join('\n');
      expect(m).toMatch(/real call adapter/);
      expect(m).toMatch(/evidence artifact/);
      expect(m).toMatch(/daily budget/);
    }
  });

  it('calling with the real adapter also requires an AI voice provider and its model (never defaulted)', () => {
    const calling = {
      ...base,
      CALLS_ENABLED: 'true',
      CALL_ADAPTER: 'ntgcalls',
      CALL_FEASIBILITY_EVIDENCE_PATH: '/tmp/e.json',
      DAILY_AI_BUDGET_USD: '5',
      OWNER_TELEGRAM_USER_ID: '1',
    };
    expect(() => loadConfig(calling)).toThrow(/AI_VOICE_PROVIDER/);
    expect(() => loadConfig({ ...calling, AI_VOICE_PROVIDER: 'gemini', GEMINI_API_KEY: 'k' })).toThrow(/GEMINI_LIVE_MODEL/);
    expect(() => loadConfig({ ...calling, AI_VOICE_PROVIDER: 'openai', OPENAI_API_KEY: 'k' })).toThrow(/OPENAI_REALTIME_MODEL/);
    expect(loadConfig({ ...calling, AI_VOICE_PROVIDER: 'gemini', GEMINI_API_KEY: 'k', GEMINI_LIVE_MODEL: 'm' }).AI_VOICE_PROVIDER).toBe('gemini');
  });

  it('requires secrets and ids in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/DATA_ENCRYPTION_KEY_REF/);
  });

  it('does not hardcode an OpenAI model and requires one when selected', () => {
    expect(() => loadConfig({ ...base, TEXT_AI_ADAPTER: 'openai', OPENAI_API_KEY: 'k' })).toThrow(/OPENAI_TEXT_MODEL/);
  });

  it('never echoes secret values in errors', () => {
    try {
      loadConfig({ ...base, TELEGRAM_API_HASH: 'short', MESSAGING_ADAPTER: 'telegram', TELEGRAM_API_ID: 'abc' });
    } catch (e) {
      expect((e as Error).message).not.toContain('short');
    }
  });

  it('rejects non-numeric owner id (usernames are not identity)', () => {
    expect(() => loadConfig({ ...base, OWNER_TELEGRAM_USER_ID: '@javlon' })).toThrow();
  });

  it('audit F-05: debug and trace logging are refused in production (they can carry conversation content)', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', LOG_LEVEL: 'debug' })).toThrow(/LOG_LEVEL/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', LOG_LEVEL: 'trace' })).toThrow(/LOG_LEVEL/);
    expect(loadConfig({ ...base, LOG_LEVEL: 'debug' }).LOG_LEVEL).toBe('debug'); // development is fine
  });

  it('audit 2026-11-03 L2: switches for features that do not exist are refused, not silently ignored', () => {
    expect(() => loadConfig({ ...base, RAW_AUDIO_RECORDING_ENABLED: 'true' })).toThrow(/RAW_AUDIO_RECORDING_ENABLED/);
    expect(() => loadConfig({ ...base, FULL_TRANSCRIPT_RETENTION_ENABLED: 'true' })).toThrow(/FULL_TRANSCRIPT_RETENTION_ENABLED/);
    expect(loadConfig({ ...base, OWNER_NAME: '' }).OWNER_NAME).toBeUndefined();
    expect(loadConfig({ ...base, OWNER_NAME: 'Farruh' }).OWNER_NAME).toBe('Farruh');
  });
});
