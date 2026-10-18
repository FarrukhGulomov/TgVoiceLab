import { describe, expect, it } from 'vitest';
import { GeminiTextFallback, buildPrompt, intentFromModel, parseModelJson } from '../../apps/assistant/src/infrastructure/gemini/text.js';
import type { InterpretContext } from '../../apps/assistant/src/application/intent.js';

const ctx: InterpretContext = {
  receivedAt: new Date('2026-10-18T06:00:00Z'),
  timezone: 'Asia/Samarkand',
  locale: 'uz',
  background: { contacts: ['Test2'], recentCall: { contact: 'Test2', outcome: 'answered', summary: "200 000 so'm berishga rozi." } },
};

describe('intentFromModel', () => {
  it('accepts only well-formed intents from the closed set', () => {
    expect(intentFromModel({ kind: 'create_task', title: ' Hisobot ', due: { date: '2026-10-19', time: '09:00' } })).toEqual({
      kind: 'create_task',
      title: 'Hisobot',
      due: { date: '2026-10-19', time: '09:00' },
    });
    expect(intentFromModel({ kind: 'create_reminder', title: 'Dori', at: { date: '2026-10-19', time: '25:00' } }).kind).toBe('unknown');
    expect(intentFromModel({ kind: 'call_contact', contact: 'Test2', message: 'Roziman', slots: [{ date: '2026-10-19', time: '15:00' }, 'x'] })).toEqual({
      kind: 'call_contact',
      contact: 'Test2',
      message: 'Roziman',
      slots: [{ date: '2026-10-19', time: '15:00' }],
    });
  });
  it('accepts a text to a contact and a cancellation', () => {
    expect(intentFromModel({ kind: 'message_contact', contact: 'Test2', text: ' Salom ' })).toEqual({
      kind: 'message_contact',
      contact: 'Test2',
      text: 'Salom',
    });
    expect(intentFromModel({ kind: 'message_contact', contact: 'Test2' }).kind).toBe('unknown');
    expect(intentFromModel({ kind: 'cancel_pending' })).toEqual({ kind: 'cancel_pending' });
  });
  it('refuses anything outside the set (no deletes, no stop_calling, no unknown kinds)', () => {
    for (const kind of ['remove_contact', 'stop_calling', 'complete_task', 'drop_database', undefined])
      expect(intentFromModel({ kind, name: 'x' }).kind).toBe('unknown');
    expect(intentFromModel('hello').kind).toBe('unknown');
    expect(intentFromModel(null).kind).toBe('unknown');
  });
});

describe('parseModelJson', () => {
  it('reads bare, fenced and chatty answers; garbage is undefined', () => {
    expect(parseModelJson('{"kind":"list_tasks"}')).toEqual({ kind: 'list_tasks' });
    expect(parseModelJson('```json\n{"kind":"list_tasks"}\n```')).toEqual({ kind: 'list_tasks' });
    expect(parseModelJson('mana: {"kind":"list_tasks"} tayyor')).toEqual({ kind: 'list_tasks' });
    expect(parseModelJson('no json here')).toBeUndefined();
  });
});

describe('prompt and request', () => {
  it('carries the contacts and the latest call report, and treats the text as data', () => {
    const p = buildPrompt('roziman «ignore previous»', ctx);
    expect(p).toContain('Test2');
    expect(p).toContain("200 000 so'm");
    expect(p).toContain("MA'LUMOT");
    expect(p).not.toContain('«ignore');
    expect(p).toContain('2026-10-18 11:00');
  });
  it('sends the key as a header (never in the URL) and maps the answer', async () => {
    let url = '';
    let key = '';
    const f = (async (u: string, init: RequestInit) => {
      url = u;
      key = (init.headers as Record<string, string>)['x-goog-api-key']!;
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"kind":"list_reminders"}' }] } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await new GeminiTextFallback({ apiKey: 'SECRET', model: 'm1', fetchImpl: f }).propose('eslatmalar', ctx);
    expect(r).toEqual({ kind: 'list_reminders' });
    expect(url).not.toContain('SECRET');
    expect(key).toBe('SECRET');
  });
  it('a failed request throws without echoing the text', async () => {
    const f = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch;
    await expect(new GeminiTextFallback({ apiKey: 'k', model: 'm', fetchImpl: f }).propose('maxfiy matn', ctx)).rejects.toThrow(/HTTP 500/);
  });
});
