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
});
