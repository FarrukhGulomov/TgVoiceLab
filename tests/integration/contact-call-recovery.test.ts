import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../support/test-db.js';
import { seedOwner, type SeededOwner } from '../support/seed.js';
import { boot } from '../support/harness.js';
import { FakeClock } from '../../apps/assistant/src/application/clock.js';
import { FakeCallAdapter, FakeMessaging } from '../../apps/assistant/src/testing/fakes.js';
import type { DerivedCapabilities } from '../../apps/assistant/src/modules/calls/capability-evidence.js';
import { ensureDailyBudget } from '../../apps/assistant/src/modules/operations/operations.service.js';
import type { IncomingMessage } from '../../apps/assistant/src/modules/messaging/intake.service.js';
import type { MessageComposerPort } from '../../apps/assistant/src/application/ports.js';

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
async function setup(script: FakeCallAdapter['script'], composer?: MessageComposerPort) {
  const clock = new FakeClock(new Date('2026-10-15T06:00:00Z')); // 11:00 Samarkand, inside the call window
  const adapter = new FakeCallAdapter();
  adapter.script = script;
  adapter.reconcileResult = 'ended';
  const app = boot(t.url, clock, new FakeMessaging(), 'w', {
    callAdapter: adapter,
    deriveCapabilities: () => CAPS,
    callsEnabled: true,
    ringTimeoutMs: 3000,
    ...(composer ? { composer } : {}),
  });
  await app.operations.setKillSwitch(o.ownerId, false, 'test');
  await ensureDailyBudget(t.db, o.ownerId, '2026-10-15', 5_000_000);
  const say = async (text: string) => {
    const id = String(++seq);
    const msg: IncomingMessage = {
      accountId: o.accountId,
      updateKey: `msg:rc${id}`,
      providerMessageId: id,
      senderTelegramId: o.telegramUserId,
      chat: { type: 'private', id: o.telegramUserId },
      receivedAt: clock.now(),
      text,
    };
    await app.intake.handle(msg);
  };
  /** Let time pass in steps; each step runs jobs (dials) and the outbox. */
  const run = async (steps: number) => {
    for (let i = 0; i < steps; i++) {
      clock.advanceMs(60_000);
      await app.tick();
      await app.tick();
    }
  };
  return {
    app,
    adapter,
    say,
    run,
    texts: () => app.messaging.sent.map((m) => m.text),
    sentTo: (id: string) => app.messaging.sent.filter((m) => m.toTelegramUserId === id),
  };
}

describe('a contact call whose audio never connects', () => {
  it('is redialled twice (3 tries in all), then the message goes out as text', async () => {
    const s = await setup(
      { kind: 'event_stream_dies' },
      { compose: async () => "Assalomu alaykum! Men Farruhning AI yordamchisiman. Narx haqida so'ramoqchi edi." },
    );
    await s.say("kontakt qo'sh Javlon 555000111");
    await s.say("Javlonga qo'ng'iroq qilib narxni so'ra");
    await s.run(12);
    expect(s.adapter.dials).toHaveLength(3);
    expect((await t.db.query('SELECT attempt FROM call_requests ORDER BY created_at')).rows.map((r) => r.attempt)).toEqual([1, 2, 3]);
    const toContact = s.sentTo('555000111');
    expect(toContact).toHaveLength(1);
    expect(toContact[0]!.text).toContain('AI yordamchisiman');
    expect(s.texts().some((x) => x.includes('did not connect after 3 tries'))).toBe(true);
    await s.app.close();
  });

  it('without a text composer the owner is told how to send it, and nothing is sent to the contact', async () => {
    const s = await setup({ kind: 'event_stream_dies' });
    await s.say("kontakt qo'sh Javlon 555000111");
    await s.say("Javlonga qo'ng'iroq qilib narxni so'ra");
    await s.run(12);
    expect(s.adapter.dials).toHaveLength(3);
    expect(s.sentTo('555000111')).toHaveLength(0);
    expect(s.texts().some((x) => x.includes('message Javlon'))).toBe(true);
    await s.app.close();
  });

  it('no answer is never redialled', async () => {
    const s = await setup({ kind: 'no_answer' });
    await s.say("kontakt qo'sh Javlon 555000111");
    await s.say("Javlonga qo'ng'iroq qilib narxni so'ra");
    await s.run(8);
    expect(s.adapter.dials).toHaveLength(1);
    await s.app.close();
  });
});
