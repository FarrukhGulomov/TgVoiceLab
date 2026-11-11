import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../support/test-db.js';
import { seedOwner, type SeededOwner } from '../support/seed.js';
import { boot } from '../support/harness.js';
import { FakeClock } from '../../apps/assistant/src/application/clock.js';
import { FakeCallAdapter, FakeMessaging } from '../../apps/assistant/src/testing/fakes.js';
import type { DerivedCapabilities } from '../../apps/assistant/src/modules/calls/capability-evidence.js';
import { ensureDailyBudget } from '../../apps/assistant/src/modules/operations/operations.service.js';
import type { IncomingMessage } from '../../apps/assistant/src/modules/messaging/intake.service.js';

const CAPS: DerivedCapabilities = {
  privateOutbound: true,
  privateInbound: false,
  pcmSend: true,
  pcmReceive: true,
  evidenceArtifact: 'TEST-ONLY',
  buildFingerprint: 'test',
  productionCallingAllowed: true,
  ownerCallingAllowed: true,
  thirdPartyConsentMechanismProven: false,
  reasons: [],
};
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
async function setup() {
  const clock = new FakeClock(new Date('2026-10-15T06:00:00Z'));
  const adapter = new FakeCallAdapter();
  adapter.script = { kind: 'unknown_outcome' }; // the dial may or may not have reached Telegram: the call becomes outcome_unknown
  const app = boot(t.url, clock, new FakeMessaging(), 'w', { callAdapter: adapter, deriveCapabilities: () => CAPS, callsEnabled: true, ringTimeoutMs: 3000 });
  await app.operations.setKillSwitch(o.ownerId, false, 'test');
  await ensureDailyBudget(t.db, o.ownerId, '2026-10-15', 5_000_000);
  const say = async (text: string) => {
    const id = String(++seq);
    const msg: IncomingMessage = {
      accountId: o.accountId,
      updateKey: `msg:cs${id}`,
      providerMessageId: id,
      senderTelegramId: o.telegramUserId,
      chat: { type: 'private', id: o.telegramUserId },
      receivedAt: clock.now(),
      text,
    };
    await app.intake.handle(msg);
  };
  const last = async () => {
    for (let i = 0; i < 3; i++) await app.tick();
    return app.messaging.sent.at(-1)!.text;
  };
  const states = async () => (await t.db.query(`SELECT state FROM calls`)).rows.map((r) => r.state as string);
  return { app, say, last, states };
}

describe('clearing stuck calls from chat', () => {
  it('asks first, clears only after "yes", and reports when nothing is stuck', async () => {
    const s = await setup();
    await s.say("qo'ng'iroqni tozala");
    expect(await s.last()).toContain('No stuck calls');
    await s.say("kontakt qo'sh Javlon 555000111");
    await s.say("Javlonga qo'ng'iroq qilib salom ayt");
    for (let i = 0; i < 3; i++) await s.app.tick();
    expect(await s.states()).toEqual(['outcome_unknown']);
    await s.say("qo'ng'iroqni tozala");
    expect(await s.last()).toContain('reply «yes»');
    expect(await s.states()).toEqual(['outcome_unknown']); // asking changes nothing
    await s.say('yes');
    expect(await s.last()).toContain('Cleared 1');
    expect(await s.states()).toEqual(['ended']);
    await s.app.close();
  });

  it('"no" leaves the call as it was', async () => {
    const s = await setup();
    await s.say("kontakt qo'sh Javlon 555000111");
    await s.say("Javlonga qo'ng'iroq qilib salom ayt");
    for (let i = 0; i < 3; i++) await s.app.tick();
    await s.say("qo'ng'iroqni tozala");
    await s.say("yo'q");
    expect(await s.states()).toEqual(['outcome_unknown']);
    await s.app.close();
  });
});
