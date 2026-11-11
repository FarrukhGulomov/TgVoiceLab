import { describe, expect, it } from 'vitest';
import { OpenAiTextFallback } from '../../apps/assistant/src/infrastructure/openai/text.js';
import { loadConfig } from '../../apps/assistant/src/bootstrap/config.js';
import type { InterpretContext } from '../../apps/assistant/src/application/intent.js';

const ctx = { receivedAt: new Date('2026-10-20T10:00:00Z'), timezone: 'Asia/Samarkand' } as unknown as InterpretContext;

const mk = (content: unknown, status = 200) => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });
  }) as unknown as typeof fetch;
  return { t: new OpenAiTextFallback({ apiKey: 'sk-secret', model: 'm-1', fetchImpl }), seen };
};

describe('OpenAiTextFallback', () => {
  it('posts to chat/completions with a bearer key, the configured model and a JSON answer format; no temperature', async () => {
    const { t, seen } = mk('{"kind":"list_tasks"}');
    expect(await t.propose('vazifalarim qani', ctx)).toEqual({ kind: 'list_tasks' });
    expect(seen[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer sk-secret');
    const body = JSON.parse(String(seen[0]!.init.body));
    expect(body.model).toBe('m-1');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.temperature).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
    expect(body.max_completion_tokens).toBeGreaterThan(0);
    expect(body.messages[0].content).toContain('vazifalarim qani'); // the owner's text is in the prompt as data
  });

  it('validates what the model returns: a bad intent becomes unknown, prose becomes a reply', async () => {
    expect(await mk('{"kind":"create_reminder","title":"x"}').t.propose('x', ctx)).toEqual({ kind: 'unknown' }); // no time
    expect(await mk('{"kind":"drop_database"}').t.propose('x', ctx)).toEqual({ kind: 'unknown' });
    expect(await mk('Salom, yaxshiman.').t.propose('x', ctx)).toEqual({ kind: 'reply', text: 'Salom, yaxshiman.' });
    expect(await mk(null).t.propose('x', ctx)).toEqual({ kind: 'unknown' });
  });

  it('a failed request throws without the key', async () => {
    const { t } = mk('', 401);
    await expect(t.propose('x', ctx)).rejects.toThrow('text AI request failed: HTTP 401');
  });

  it('composes a short text for a contact', async () => {
    const { t } = mk('Salom, men Farruhning yordamchisiman.');
    expect(await t.compose({ ownerName: 'Farruh', contactName: 'Ali', brief: 'uchrashuv ertaga' })).toBe('Salom, men Farruhning yordamchisiman.');
    expect(await mk('').t.compose({ ownerName: 'Farruh', contactName: 'Ali', brief: 'x' })).toBeNull();
  });
});

describe('TEXT_AI_ADAPTER=openai configuration', () => {
  const base = { NODE_ENV: 'test', DATABASE_URL: 'postgres://x', TELEGRAM_API_ID: '1', TELEGRAM_API_HASH: 'abcdefgh1234' } as Record<string, string>;
  it('needs the key and the model', () => {
    expect(() => loadConfig({ ...base, TEXT_AI_ADAPTER: 'openai' })).toThrow(/OPENAI_TEXT_MODEL/);
    expect(loadConfig({ ...base, TEXT_AI_ADAPTER: 'openai', OPENAI_API_KEY: 'k', OPENAI_TEXT_MODEL: 'm' }).TEXT_AI_ADAPTER).toBe('openai');
  });
});
