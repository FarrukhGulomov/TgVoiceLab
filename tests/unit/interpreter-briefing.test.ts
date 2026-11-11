import { describe, expect, it } from 'vitest';
import { RulesInterpreter } from '../../apps/assistant/src/modules/messaging/rules-interpreter.js';

const interp = new RulesInterpreter();
const NOW = new Date('2026-10-15T05:00:00Z');
const run = (text: string, locale: 'uz' | 'en' = 'en') => interp.interpret(text, { receivedAt: NOW, timezone: 'Asia/Samarkand', locale });

describe('daily briefing intents', () => {
  it.each([
    ['daily briefing at 08:00', '08:00'],
    ['brief me every day at 9:30', '09:30'],
    ['set a morning briefing at 7:15', '07:15'],
    ['har kuni soat 08:00 da brifing', '08:00'],
    ['kunlik brifing 18:45', '18:45'],
  ])('%s -> set_briefing %s', async (text, time) => {
    expect(await run(text, text.includes('brifing') ? 'uz' : 'en')).toEqual({ kind: 'set_briefing', time });
  });

  it('asks for the time instead of guessing it', async () => {
    expect((await run('daily briefing')).kind).toBe('clarify');
  });

  it.each(['cancel briefing', 'stop the daily briefing', 'turn off briefing', "brifingni o'chir"])('%s -> cancel_briefing', async (text) => {
    expect(await run(text, text.includes('brifing') ? 'uz' : 'en')).toEqual({ kind: 'cancel_briefing' });
  });

  it('a negated or hypothetical cancel never cancels', async () => {
    for (const text of ["don't cancel briefing", 'should I cancel the briefing?', 'e.g. "cancel briefing" would stop it'])
      expect((await run(text)).kind).not.toBe('cancel_briefing');
  });

  it('a reminder or task that only mentions a briefing is not a briefing command', async () => {
    expect((await run('remind me to prepare the briefing tomorrow at 9:00')).kind).toBe('create_reminder');
    expect((await run('add task prepare briefing tomorrow')).kind).toBe('create_task');
  });
});

describe('reminders by call (chat)', () => {
  it.each([
    ["ertaga 9:00 da dori ichishni qo'ng'iroq qilib eslat", 'dori ichishni'],
    ["qo'ng'iroq bilan eslat: bugun 18:00 da uchrashuv", 'uchrashuv'],
    ['remind me by call tomorrow at 9:00 to take the medicine', 'take the medicine'],
    ['call me tomorrow at 09:00 as a reminder to pay rent. remind me', 'pay rent'],
  ])('%s -> byCall, and the phrase is not in the title', async (text, titlePart) => {
    const r = await run(text, text.includes("qo'ng") ? 'uz' : 'en');
    expect(r).toMatchObject({ kind: 'create_reminder', byCall: true });
    const title = (r as { title: string }).title.toLowerCase();
    expect(title).toContain(titlePart.split(' ')[0]!);
    expect(title).not.toMatch(/qo'ng'iroq|by call|call me|qilib/);
  });
  it('a plain reminder is not a call reminder', async () => {
    const r = await run('remind me tomorrow at 9:00 to take the medicine');
    expect(r).toMatchObject({ kind: 'create_reminder' });
    expect(r).not.toHaveProperty('byCall');
  });
  it('a missing time keeps the by-call wish in the pending draft', async () => {
    const r = await run("ertaga dori ichishni qo'ng'iroq qilib eslat", 'uz');
    expect(r).toMatchObject({ kind: 'clarify', draft: { kind: 'create_reminder', byCall: true, missing: 'time' } });
  });
  it('"don\'t call me" is still the opt-out, never a call reminder', async () => {
    expect(await run("don't call me")).toEqual({ kind: 'stop_calling' });
    expect(await run("qo'ng'iroq qilma")).toEqual({ kind: 'stop_calling' });
  });
});
