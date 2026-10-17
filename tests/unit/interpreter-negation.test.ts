import { describe, expect, it } from 'vitest';
import { RulesInterpreter } from '../../apps/assistant/src/modules/messaging/rules-interpreter.js';

/** Audit F01: a destructive command must be clearly affirmative; negation, questions and quoted examples never mutate. */
const interp = new RulesInterpreter();
const NOW = new Date('2026-10-15T05:00:00Z');
const run = (text: string, locale: 'uz' | 'en' = 'en') => interp.interpret(text, { receivedAt: NOW, timezone: 'Asia/Samarkand', locale });
const MUTATING = ['complete_task', 'cancel_reminder', 'reschedule_task', 'reschedule_reminder'];

describe('destructive intents require an affirmative command (F01)', () => {
  const NOT_COMMANDS = [
    'do not complete task 1',
    "don't delete reminder 1",
    "don't cancel reminder 1",
    'never mark task 2 done',
    "I haven't finished task 1",
    "task 1 isn't done",
    "please don't move task 1 to tomorrow",
    'should I cancel reminder 1?',
    'can you mark task 1 done?',
    'e.g. "cancel reminder 1" would delete it',
    'say «done 1» to complete a task',
    'I said "cancel reminder 2" earlier by mistake, ignore that',
  ];
  for (const text of NOT_COMMANDS)
    it(`en: ${text}`, async () => {
      const r = await run(text);
      expect(MUTATING).not.toContain(r.kind);
    });

  const UZ_NOT_COMMANDS = [
    '1-vazifani bajarmadim, hali tugadi demadim',
    '1-eslatmani bekor qilma',
    "eslatma 1 ni o'chirmang",
    '1-vazifa bajarildi emas',
    '2-vazifani ko‘chirma, ertaga emas',
    '«bajarildi 1» deb yozsam nima bo‘ladi?',
  ];
  for (const text of UZ_NOT_COMMANDS)
    it(`uz: ${text}`, async () => {
      const r = await run(text, 'uz');
      expect(MUTATING).not.toContain(r.kind);
    });

  it('affirmative commands still work', async () => {
    expect(await run('done 1')).toMatchObject({ kind: 'complete_task', ref: { by: 'ordinal', n: 1 } });
    expect(await run('cancel reminder 2')).toMatchObject({ kind: 'cancel_reminder', ref: { by: 'ordinal', n: 2 } });
    expect(await run('1-vazifa bajarildi', 'uz')).toMatchObject({ kind: 'complete_task', ref: { by: 'ordinal', n: 1 } });
    expect(await run('move task 1 to friday at 10:00')).toMatchObject({ kind: 'reschedule_task' });
    expect(await run('cancel reminder no. 2')).toMatchObject({ kind: 'cancel_reminder', ref: { by: 'ordinal', n: 2 } });
  });

  it('the emergency opt-out phrases keep working despite negation words', async () => {
    expect(await run("don't call me")).toEqual({ kind: 'stop_calling' });
    expect(await run('stop calling me')).toEqual({ kind: 'stop_calling' });
    expect(await run("qo'ng'iroq qilmang", 'uz')).toEqual({ kind: 'stop_calling' });
  });
});
