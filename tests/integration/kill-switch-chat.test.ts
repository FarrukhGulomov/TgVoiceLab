import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../support/test-db.js';
import { seedOwner, type SeededOwner } from '../support/seed.js';
import { boot } from '../support/harness.js';
import { FakeClock } from '../../apps/assistant/src/application/clock.js';
import { RulesInterpreter } from '../../apps/assistant/src/modules/messaging/rules-interpreter.js';

let t: TestDb;
let o: SeededOwner;
beforeEach(async () => {
  t = await createTestDb();
  o = await seedOwner(t.db);
});
afterEach(async () => {
  await t.drop();
});

const ALL_PASS = {
  privateOutbound: true,
  privateInbound: false,
  pcmSend: true,
  pcmReceive: true,
  evidenceArtifact: 'TEST-ONLY',
  buildFingerprint: 'test',
  productionCallingAllowed: true,
  ownerCallingAllowed: true,
  thirdPartyConsentMechanismProven: true,
  reasons: [],
};

let seq = 0;
function setup(ready = true) {
  const clock = new FakeClock(new Date('2026-10-15T06:00:00Z'));
  const app = boot(t.url, clock, undefined, undefined, ready ? { deriveCapabilities: () => ALL_PASS } : {});
  const say = async (text: string) => {
    const id = String(++seq);
    await app.intake.handle({
      accountId: o.accountId,
      updateKey: `msg:ks${id}`,
      providerMessageId: id,
      senderTelegramId: o.telegramUserId,
      chat: { type: 'private', id: o.telegramUserId },
      receivedAt: clock.now(),
      text,
    });
    for (let i = 0; i < 4; i++) await app.tick();
    return app.messaging.sent.at(-1)!.text;
  };
  const on = () => app.operations.isKillSwitchOn(app.db, o.ownerId);
  return { app, say, on };
}

describe('the interpreter: the kill switch needs explicit wording', () => {
  const r = new RulesInterpreter();
  const ctx = { receivedAt: new Date('2026-10-15T06:00:00Z'), timezone: 'Asia/Samarkand', locale: 'uz' as const };
  it('recognises the explicit commands, never an ordinary sentence about calls', async () => {
    for (const s of ['kill switch on', 'Kill-switch yoq', "barcha qo'ng'iroqlarni to'xtat", "favqulodda to'xtat", 'emergency stop'])
      expect(await r.interpret(s, ctx), s).toEqual({ kind: 'kill_switch', on: true });
    for (const s of ['kill switch off', "kill switch o'chir", "qo'ng'iroqlarni qayta yoq"])
      expect(await r.interpret(s, ctx), s).toEqual({ kind: 'kill_switch', on: false });
    for (const s of ["Javlonga qo'ng'iroq qil", "ertaga soat 9 da qo'ng'iroq qilib eslat", 'qo‘ng‘iroqlar haqida gapir']) {
      const x = await r.interpret(s, ctx);
      expect(x.kind, s).not.toBe('kill_switch');
    }
  });
});

describe('the kill switch from chat', () => {
  it('ON acts at once and says so; OFF asks first and only a plain "ha" switches it off', async () => {
    const s = setup();
    await s.app.operations.setKillSwitch(o.ownerId, false, 'test');
    expect(await s.on()).toBe(false);
    expect(await s.say('kill switch on')).toContain('kill switch is ON');
    expect(await s.on()).toBe(true);
    expect((await t.db.query(`SELECT count(*)::int n FROM audit_events WHERE action='killswitch.on'`)).rows[0].n).toBeGreaterThan(0);

    // OFF is never done on one sentence
    expect(await s.say('kill switch off')).toContain('Switch the calling kill switch OFF?');
    expect(await s.on()).toBe(true);
    expect(await s.say('balki')).not.toContain('is OFF'); // anything but a plain yes does not confirm
    expect(await s.on()).toBe(true);
    expect(await s.say('ha')).toContain('kill switch is OFF');
    expect(await s.on()).toBe(false);
  });

  it('"yo\'q" to the OFF question leaves it on', async () => {
    const s = setup();
    expect(await s.on()).toBe(true); // a new owner starts with it on
    await s.say('kill switch off');
    await s.say("yo'q");
    expect(await s.on()).toBe(true);
  });

  it('OFF while the build has no evidence says that calls still cannot start, and why', async () => {
    const s = setup(false);
    await s.say('kill switch off');
    const said = await s.say('ha');
    expect(await s.on()).toBe(false);
    expect(said).toContain('calls still cannot start');
    expect(said).toContain('docs/runbooks/owner-calling.md');
  });

  it('a stranger cannot touch it', async () => {
    const s = setup();
    await s.app.operations.setKillSwitch(o.ownerId, false, 'test');
    await s.app.intake.handle({
      accountId: o.accountId,
      updateKey: 'msg:stranger',
      providerMessageId: 'x',
      senderTelegramId: '999',
      chat: { type: 'private', id: '999' },
      receivedAt: new Date('2026-10-15T06:00:00Z'),
      text: 'kill switch on',
    });
    expect(await s.on()).toBe(false);
  });
});
