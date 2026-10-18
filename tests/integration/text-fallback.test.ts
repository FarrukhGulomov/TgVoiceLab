import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../support/test-db.js';
import { seedOwner, type SeededOwner } from '../support/seed.js';
import { boot } from '../support/harness.js';
import { FakeClock } from '../../apps/assistant/src/application/clock.js';
import type { IncomingMessage } from '../../apps/assistant/src/modules/messaging/intake.service.js';
import type { Intent, InterpretContext } from '../../apps/assistant/src/application/intent.js';
import type { IntentFallbackPort } from '../../apps/assistant/src/application/ports.js';

let t: TestDb;
let o: SeededOwner;
beforeEach(async () => {
  t = await createTestDb();
  o = await seedOwner(t.db);
});
afterEach(async () => {
  await t.drop();
});

let seq = 0;
function setup(propose: (text: string, ctx: InterpretContext) => Promise<Intent>) {
  const clock = new FakeClock(new Date('2026-10-15T06:00:00Z'));
  const seen: InterpretContext[] = [];
  const textFallback: IntentFallbackPort = {
    propose: async (text, ctx) => {
      seen.push(ctx);
      return propose(text, ctx);
    },
  };
  const app = boot(t.url, clock, undefined, 'w', { textFallback });
  const say = async (text: string) => {
    const id = String(++seq);
    const msg: IncomingMessage = {
      accountId: o.accountId,
      updateKey: `msg:tf${id}`,
      providerMessageId: id,
      senderTelegramId: o.telegramUserId,
      chat: { type: 'private', id: o.telegramUserId },
      receivedAt: clock.now(),
      text,
    };
    await app.intake.handle(msg);
  };
  return {
    app,
    say,
    seen,
    texts: async () => {
      await app.tick();
      return app.messaging.sent.map((m) => m.text);
    },
  };
}

describe('free-form text fallback', () => {
  it('a call the AI proposes asks first; only "ha" places it, and the model sees the contact list', async () => {
    const s = setup(async () => ({ kind: 'call_contact', contact: 'Javlon', message: "Egasi 200 000 so'mga rozi" }));
    await s.say("kontakt qo'sh Javlon 555000111");
    await s.say('men roziman');
    expect(s.seen[0]!.background?.contacts).toEqual(['Javlon']);
    expect((await s.texts()).at(-1)).toContain('Javlon');
    expect((await s.texts()).at(-1)).toContain('«yes»');
    expect((await t.db.query('SELECT 1 FROM call_requests')).rowCount).toBe(0); // a guess never rings anyone
    await s.say('ha');
    expect((await t.db.query('SELECT 1 FROM call_requests')).rowCount).toBe(1);
    await s.app.close();
  });

  it('anything but a plain yes leaves the proposal unexecuted', async () => {
    const s = setup(async () => ({ kind: 'call_contact', contact: 'Javlon', message: 'Salom' }));
    await s.say("kontakt qo'sh Javlon 555000111");
    await s.say('men roziman');
    await s.say("yo'q, kerak emas");
    expect((await t.db.query('SELECT 1 FROM call_requests')).rowCount).toBe(0);
    await s.app.close();
  });

  it('"yuq shartmas indama" cancels a pending proposal without asking the model again', async () => {
    const s = setup(async () => ({ kind: 'call_contact', contact: 'Javlon', message: 'Salom' }));
    await s.say("kontakt qo'sh Javlon 555000111");
    await s.say('men roziman');
    const asked = s.seen.length;
    await s.say('yuq shartmas indama');
    expect(s.seen).toHaveLength(asked);
    expect((await s.texts()).at(-1)).toContain('cancelled');
    await s.say('ha'); // the proposal is gone: a late "ha" places nothing
    expect((await t.db.query('SELECT 1 FROM call_requests')).rowCount).toBe(0);
    await s.app.close();
  });

  it("a text to a contact is confirmed first, then sent in the owner's name, and the owner is told", async () => {
    const s = setup(async () => ({ kind: 'message_contact', contact: 'Javlon', text: "Salom, 3 million so'mga rozi bo'ldim." }));
    await s.say("kontakt qo'sh Javlon 555000111");
    await s.say('men roziman faqat buni tekst qilib unga junat');
    const asked = (await s.texts()).at(-1)!;
    expect(asked).toContain('text message');
    expect(asked).toContain('3 million');
    expect(s.app.messaging.sent.some((m) => m.toTelegramUserId === '555000111')).toBe(false); // nothing leaves before the yes
    await s.say('ha');
    await s.app.tick();
    const toContact = s.app.messaging.sent.filter((m) => m.toTelegramUserId === '555000111');
    expect(toContact).toHaveLength(1);
    expect(toContact[0]!.text).toContain('3 million');
    expect((await s.texts()).some((x) => x.includes('delivered'))).toBe(true);
    expect((await t.db.query('SELECT 1 FROM call_requests')).rowCount).toBe(0); // a text is not a call
    await s.app.close();
  });

  it('the model also sees recent exchanges and the pending proposal', async () => {
    const s = setup(async () => ({ kind: 'call_contact', contact: 'Javlon', message: 'Salom' }));
    await s.say("kontakt qo'sh Javlon 555000111");
    await s.say('men roziman');
    await s.app.tick();
    await s.say('boshqa narsa deb yozaman ammo tushunarsiz');
    const last = s.seen.at(-1)!.background!;
    expect(last.pending).toContain('Javlon');
    expect(last.history?.some((h) => h.from === 'owner' && h.text === 'men roziman')).toBe(true);
    expect(last.history?.some((h) => h.from === 'assistant')).toBe(true);
    await s.app.close();
  });

  it('chat: a conversational reply is sent as is, changes nothing, and the model sees tasks and reminders', async () => {
    const s = setup(async () => ({ kind: 'reply', text: 'Salom! Bugun sizda bitta vazifa bor.' }));
    await s.say('add task: hisobot tayyorlash');
    await s.say('salom, bugun nima bor?');
    expect((await s.texts()).at(-1)).toBe('Salom! Bugun sizda bitta vazifa bor.');
    expect(s.seen.at(-1)!.background!.tasks!.join(' ')).toContain('hisobot');
    expect((await t.db.query('SELECT 1 FROM tasks')).rowCount).toBe(1); // chatting created nothing
    await s.app.close();
  });

  it('chatting while a proposal waits keeps the proposal alive', async () => {
    let n = 0;
    const s = setup(async () => (++n === 1 ? { kind: 'call_contact', contact: 'Javlon', message: 'Salom' } : { kind: 'reply', text: 'Albatta, gapiring.' }));
    await s.say("kontakt qo'sh Javlon 555000111");
    await s.say('men roziman');
    await s.say('rahmat, bir daqiqa');
    await s.say('ha');
    expect((await t.db.query('SELECT 1 FROM call_requests')).rowCount).toBe(1);
    await s.app.close();
  });

  it('a fallback failure is treated as unknown and nothing happens', async () => {
    const s = setup(async () => {
      throw new Error('boom');
    });
    await s.say('nimadir tushunarsiz gap');
    expect((await s.texts()).at(-1)).toContain('did not understand');
    await s.app.close();
  });

  it('rules still win: a recognised command never reaches the model', async () => {
    const s = setup(async () => ({ kind: 'unknown' }));
    await s.say('vazifalarim');
    expect(s.seen).toHaveLength(0);
    await s.app.close();
  });
});
