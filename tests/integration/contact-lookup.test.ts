import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../support/test-db.js';
import { seedOwner, type SeededOwner } from '../support/seed.js';
import { boot } from '../support/harness.js';
import { FakeClock } from '../../apps/assistant/src/application/clock.js';
import { FakeMessaging } from '../../apps/assistant/src/testing/fakes.js';
import type { IncomingMessage } from '../../apps/assistant/src/modules/messaging/intake.service.js';

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
function setup() {
  const clock = new FakeClock(new Date('2026-10-17T07:00:00Z'));
  const peers = {
    resolve: async (q: { username?: string; phone?: string }) =>
      q.username === 'ofiya_k' || q.phone === '+998901234567' ? { telegramUserId: '777000222', displayName: 'Ofiya Karimova' } : null,
  };
  const app = boot(t.url, clock, new FakeMessaging(), 'w', { peers });
  const send = async (extra: Partial<IncomingMessage>) => {
    const id = String(++seq);
    await app.intake.handle({
      accountId: o.accountId,
      updateKey: `msg:cl${id}`,
      providerMessageId: id,
      senderTelegramId: o.telegramUserId,
      chat: { type: 'private', id: o.telegramUserId },
      receivedAt: clock.now(),
      ...extra,
    });
    await app.tick();
    return app.messaging.sent.at(-1)?.text ?? '';
  };
  return { app, send };
}

describe('adding contacts without a numeric id', () => {
  it('by @username, by phone, and by a shared contact card', async () => {
    const s = setup();
    expect(await s.send({ text: "kontakt qo'sh Ofiyatim @ofiya_k" })).toContain('Ofiya Karimova');
    expect((await t.db.query(`SELECT telegram_user_id FROM contacts`)).rows).toEqual([{ telegram_user_id: '777000222' }]);
    await s.send({ text: "kontaktni o'chir Ofiyatim" });
    await s.send({ text: "kontakt qo'sh Ofiya +998 90 123 45 67" });
    expect((await t.db.query(`SELECT count(*)::int n FROM contacts WHERE ai_consent_revoked_at IS NULL`)).rows[0].n).toBe(1);
    await s.send({ contactCard: { userId: '888000333', name: 'Javlon' } });
    expect((await t.db.query(`SELECT telegram_user_id FROM contacts ORDER BY created_at`)).rows.map((r) => r.telegram_user_id)).toContain('888000333');
    await s.app.close();
  });
  it('an unknown @username adds nothing and says so', async () => {
    const s = setup();
    expect(await s.send({ text: "kontakt qo'sh Kimdir @nobody_here" })).toContain('could not find');
    expect((await t.db.query(`SELECT count(*)::int n FROM contacts`)).rows[0].n).toBe(0);
    await s.app.close();
  });
});
