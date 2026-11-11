import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../support/test-db.js';
import { seedOwner, type SeededOwner } from '../support/seed.js';
import { boot } from '../support/harness.js';
import { FakeClock } from '../../apps/assistant/src/application/clock.js';
import { emitOutbox } from '../../apps/assistant/src/modules/outbox/outbox.js';

let t: TestDb;
let o: SeededOwner;
beforeEach(async () => {
  t = await createTestDb();
  o = await seedOwner(t.db);
});
afterEach(async () => {
  await t.drop();
});

describe("call notices speak the owner's language", () => {
  it.each([
    ['uz', 'kunlik byudjet tugagan'],
    ['ru', 'дневной бюджет исчерпан'],
    ['en', 'the daily budget is exhausted'],
  ])('a refused ring is explained in %s', async (locale, expected) => {
    await t.db.query('UPDATE owners SET locale=$2 WHERE id=$1', [o.ownerId, locale]);
    const clock = new FakeClock(new Date('2026-10-15T06:00:00Z'));
    const app = boot(t.url, clock);
    await emitOutbox(
      t.db,
      {
        ownerId: o.ownerId,
        aggregateType: 'owner',
        aggregateId: o.ownerId,
        type: 'call.notify',
        payload: { variant: 'rejected', reason: 'budget_not_reserved', inbound: true },
      },
      clock.now(),
    );
    for (let i = 0; i < 4; i++) await app.tick();
    expect(app.messaging.sent.map((m) => m.text).join('\n')).toContain(expected);
    await app.close();
  });
});
