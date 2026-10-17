import { describe, expect, it } from 'vitest';
import { RulesInterpreter } from '../../apps/assistant/src/modules/messaging/rules-interpreter.js';

const interp = new RulesInterpreter();
const NOW = new Date('2026-10-17T06:30:00Z'); // Sat 11:30 Samarkand
const run = (text: string, locale: 'uz' | 'en' = 'uz') => interp.interpret(text, { receivedAt: NOW, timezone: 'Asia/Samarkand', locale });

describe('contact commands', () => {
  it.each([
    ["kontakt qo'sh Javlon 555000111", 'Javlon', '555000111'],
    ["kontakt qo'sh: Alisher Karimov 1234567890", 'Alisher Karimov', '1234567890'],
    ['add contact Javlon 555000111', 'Javlon', '555000111'],
  ])('%s -> add_contact', async (text, name, id) => {
    expect(await run(text)).toEqual({ kind: 'add_contact', name, telegramUserId: id });
  });
  it('an id that is not numeric, or a name without an id, adds nothing', async () => {
    expect((await run('add contact Javlon @javlon')).kind).not.toBe('add_contact');
    expect((await run("kontakt qo'sh Javlon")).kind).not.toBe('add_contact');
  });
  it('remove / list / owner name', async () => {
    expect(await run("kontaktni o'chir Javlon")).toEqual({ kind: 'remove_contact', name: 'Javlon' });
    expect(await run('remove contact Javlon')).toEqual({ kind: 'remove_contact', name: 'Javlon' });
    expect(await run('kontaktlarim')).toEqual({ kind: 'list_contacts' });
    expect(await run('contacts')).toEqual({ kind: 'list_contacts' });
    expect(await run('ismim Farrux')).toEqual({ kind: 'set_owner_name', name: 'Farrux' });
    expect(await run('my name is Farrukh Gulomov')).toEqual({ kind: 'set_owner_name', name: 'Farrukh Gulomov' });
  });
  it('a negated or hypothetical removal never removes', async () => {
    for (const t of ["don't remove contact Javlon", 'should I remove contact Javlon?']) expect((await run(t, 'en')).kind).not.toBe('remove_contact');
  });
});

describe('call a contact', () => {
  it("Javlonga ertaga 10:00 da qo'ng'iroq qilib hisobot tayyor bo'lganini ayt", async () => {
    expect(await run("Javlonga ertaga 10:00 da qo'ng'iroq qilib hisobot tayyor bo'lganini ayt")).toEqual({
      kind: 'call_contact',
      contact: 'Javlonga',
      message: "hisobot tayyor bo'lganini ayt",
      at: { date: '2026-10-18', time: '10:00' },
    });
  });
  it('English: call Javlon tomorrow at 10:00 and tell him the report is ready', async () => {
    expect(await run('call Javlon tomorrow at 10:00 and tell him the report is ready', 'en')).toEqual({
      kind: 'call_contact',
      contact: 'Javlon',
      message: 'the report is ready',
      at: { date: '2026-10-18', time: '10:00' },
    });
  });
  it('without a time the call is for now (no `at`)', async () => {
    const r = await run("Javlonga qo'ng'iroq qilib uchrashuv soat 15:00 da ekanini ayt");
    expect(r).toMatchObject({ kind: 'call_contact', contact: 'Javlonga' });
  });
  it('a missing message asks what to say instead of calling with nothing', async () => {
    expect((await run("Javlonga qo'ng'iroq qil")).kind).toBe('clarify');
    expect((await run('call Javlon', 'en')).kind).toBe('clarify');
  });
  it('calls to the OWNER are not contact calls: "menga" / "call me" keep their old meaning', async () => {
    expect((await run("menga ertaga 9:00 da qo'ng'iroq qilib dori ichishni eslat")).kind).toBe('create_reminder');
    expect((await run('call me tomorrow at 9:00 to take the medicine', 'en')).kind).not.toBe('call_contact');
    expect(await run("qo'ng'iroq qilma")).toEqual({ kind: 'stop_calling' });
    expect(await run("don't call me", 'en')).toEqual({ kind: 'stop_calling' });
  });
});

describe('owner phrasing seen live (voice-call reminders, relative minutes)', () => {
  const NOW2 = new Date('2026-10-17T07:44:26Z'); // 12:44 Samarkand
  const go = (text: string) => interp.interpret(text, { receivedAt: NOW2, timezone: 'Asia/Samarkand', locale: 'uz' });
  it.each([
    'Soat 12:45 da call qil menga dorini eslat ovozli callda',
    'soat 12:45 da dori ichishimni qungiroq qilib eslat',
    'soat 12:45 da dori ichishimni qungiroq qilib ayt',
  ])('%s -> call reminder at 12:45', async (text) => {
    expect(await go(text)).toMatchObject({ kind: 'create_reminder', at: { date: '2026-10-17', time: '12:45' }, byCall: true });
  });
  it('1 daqiqadan sung qungiroq qilib dori ichishni eslat -> 12:45 by call', async () => {
    const r = await go('1 daqiqadan sung qungiroq qilib dori ichishni eslat');
    expect(r).toMatchObject({ kind: 'create_reminder', at: { date: '2026-10-17', time: '12:45' }, byCall: true });
    expect((r as { title: string }).title).toBe('dori ichish');
  });
  it('"remind me to call mom" and "qo\'ng\'iroq qilishni eslat" never ring the owner', async () => {
    expect(await go("ertaga 10:00 da onamga qo'ng'iroq qilishni eslat")).not.toHaveProperty('byCall');
  });
});

describe('live phrasing 2', () => {
  const go = (text: string, at: string) => interp.interpret(text, { receivedAt: new Date(at), timezone: 'Asia/Samarkand', locale: 'uz' });
  it('"X degan kontaktga qungiroq qil va ... sura 12:59 da" -> call_contact', async () => {
    expect(await go('Ofiyatim degan kontaktga qungiroq qil va ovqat tayyormi sura 12:59 da', '2026-10-17T07:58:30Z')).toEqual({
      kind: 'call_contact',
      contact: 'Ofiyatim',
      message: 'ovqat tayyormi sura',
      at: { date: '2026-10-17', time: '12:59' },
    });
  });
  it('"soat 13:01 ga qungiroq qil va dori ichishni eslat" -> clean title', async () => {
    expect(await go('soat 13:01 ga qungiroq qil va dori ichishni eslat', '2026-10-17T08:00:30Z')).toMatchObject({ title: 'dori ichish', byCall: true });
  });
});

describe('adding a contact without a numeric id', () => {
  it('@username and +phone become lookups; a bare name explains how', async () => {
    expect(await run("kontakt qo'sh Javlon @javlon_k")).toEqual({ kind: 'lookup_contact', name: 'Javlon', username: 'javlon_k' });
    expect(await run('add contact Ofiya +998 90 123 45 67')).toEqual({ kind: 'lookup_contact', name: 'Ofiya', phone: '+998901234567' });
    expect(await run("kontakt qo'sh @javlon_k")).toEqual({ kind: 'lookup_contact', name: '', username: 'javlon_k' });
    expect((await run("kontakt qo'sh Javlon")).kind).toBe('clarify');
  });
});

describe('call a contact and ask something that sounds like a reminder', () => {
  it('"Ofiyatimga qungiroq qilib ehtiyot bo\'lishini eslat" rings the CONTACT, not the owner', async () => {
    expect(await run("Ofiyatimga qungiroq qilib ehtiyot bo'lishini eslat")).toMatchObject({ kind: 'call_contact', contact: 'Ofiyatimga' });
  });
  it('"menga qungiroq qilib dorini eslat" still rings the owner', async () => {
    expect(await run('soat 13:01 da menga qungiroq qilib dorini eslat')).toMatchObject({ kind: 'create_reminder', byCall: true });
  });
});

describe('meeting proposals', () => {
  it('"... uchrashuv taklif qil: 15:00 yoki 17:00" carries the offered times as slots', async () => {
    expect(await run("Javlonga ertaga 10:00 da qo'ng'iroq qilib uchrashuv taklif qil: 15:00 yoki 17:00")).toMatchObject({
      kind: 'call_contact',
      contact: 'Javlonga',
      at: { date: '2026-10-18', time: '10:00' },
      slots: [
        { date: '2026-10-18', time: '15:00' },
        { date: '2026-10-18', time: '17:00' },
      ],
    });
  });
  it('without a meeting word, times in the message are just text', async () => {
    expect(await run("Javlonga qo'ng'iroq qilib soat 5 da kelishini ayt")).not.toHaveProperty('slots');
  });
});
