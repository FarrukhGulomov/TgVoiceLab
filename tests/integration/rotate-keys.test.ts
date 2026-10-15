import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../support/test-db.js';
import { seedOwner, type SeededOwner } from '../support/seed.js';
import { Envelope, parseKeyRing } from '../../apps/assistant/src/infrastructure/crypto/envelope.js';
import { DataCrypto } from '../../apps/assistant/src/infrastructure/crypto/data-crypto.js';
import { rotateKeys } from '../../apps/assistant/src/modules/retention/rotate-keys.js';
import { TaskService } from '../../apps/assistant/src/modules/tasks/tasks.service.js';

let t: TestDb;
let o: SeededOwner;
beforeEach(async () => {
  t = await createTestDb();
  o = await seedOwner(t.db);
});
afterEach(async () => {
  await t.drop();
});

describe('key rotation', () => {
  it('re-encrypts every encrypted column under the new key; data stays readable; retired key is then removable', async () => {
    const k1 = randomBytes(32).toString('base64');
    const k2 = randomBytes(32).toString('base64');
    const oldEnv = new Envelope(parseKeyRing(JSON.stringify({ active: 'k1', keys: { k1 } })));
    const bothEnv = new Envelope(parseKeyRing(JSON.stringify({ active: 'k2', keys: { k1, k2 } })));
    const newOnly = new Envelope(parseKeyRing(JSON.stringify({ active: 'k2', keys: { k2 } })));

    const oldTasks = new TaskService(new DataCrypto(oldEnv));
    for (let i = 0; i < 5; i++) await oldTasks.create(t.db, o.ownerId, { title: `task ${i}`, description: `secret ${i}` });
    await t.db.query(`INSERT INTO reminders (owner_id, title_enc, local_wall_clock, timezone) VALUES ($1,$2, now()::timestamp, 'Asia/Samarkand')`, [
      o.ownerId,
      new DataCrypto(oldEnv).enc(o.ownerId, 'reminders.title', 'old reminder'),
    ]);

    // Before rotation the retired key is still required.
    await expect(new TaskService(new DataCrypto(newOnly)).list(t.db, o.ownerId)).rejects.toThrow();

    const r1 = await rotateKeys(t.db, bothEnv, { batchSize: 2 });
    expect(r1).toEqual({ reencrypted: 11, remainingOnOldKeys: 0 }); // 5 titles + 5 descriptions + 1 reminder
    const r2 = await rotateKeys(t.db, bothEnv);
    expect(r2).toEqual({ reencrypted: 0, remainingOnOldKeys: 0 }); // idempotent

    const list = await new TaskService(new DataCrypto(newOnly)).list(t.db, o.ownerId); // old key no longer needed
    expect(list.map((x) => x.title).sort()).toEqual(['task 0', 'task 1', 'task 2', 'task 3', 'task 4']);
    expect(list.every((x) => x.description?.startsWith('secret'))).toBe(true);
    const raw = (await t.db.query<{ v: string }>('SELECT title_enc AS v FROM reminders')).rows[0]!.v;
    expect(raw.startsWith('e1.k2.')).toBe(true);
  });
});
