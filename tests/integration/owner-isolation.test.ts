import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../support/test-db.js';
import { seedOwner, type SeededOwner } from '../support/seed.js';
import { boot } from '../support/harness.js';
import { FakeClock } from '../../apps/assistant/src/application/clock.js';
import type { CallPlanBody } from '@tgvl/contracts';

/** Spec §13.1: cross-owner access must fail through every service, and must be indistinguishable from "not found". */
let t: TestDb;
let a: SeededOwner;
let b: SeededOwner;
beforeEach(async () => {
  t = await createTestDb();
  a = await seedOwner(t.db);
  b = await seedOwner(t.db);
});
afterEach(async () => {
  await t.drop();
});

const mk = () => boot(t.url, new FakeClock(new Date('2026-10-15T05:00:00Z')));

describe("owner B cannot touch owner A's data through any service", () => {
  it('tasks', async () => {
    const app = mk();
    const task = await app.tasks.create(app.db, a.ownerId, { title: 'A private task' });
    await expect(app.tasks.get(app.db, b.ownerId, task.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(app.tasks.update(app.db, b.ownerId, task.id, 1, { status: 'done' })).rejects.toMatchObject({ code: 'not_found' });
    expect(await app.tasks.list(app.db, b.ownerId)).toEqual([]);
    expect((await app.tasks.get(app.db, a.ownerId, task.id)).status).toBe('open'); // untouched
    // Absent id and foreign id produce the identical error.
    const foreign = await app.tasks.get(app.db, b.ownerId, task.id).catch((e) => e);
    const absent = await app.tasks.get(app.db, b.ownerId, '00000000-0000-4000-8000-000000000000').catch((e) => e);
    expect([foreign.code, foreign.message]).toEqual([absent.code, absent.message]);
    await app.close();
  });
  it('reminders (read, reschedule, cancel) and their jobs', async () => {
    const app = mk();
    const r = await app.reminders.create(a.ownerId, { title: 'A reminder', localDateTime: '2026-10-16T09:00' });
    await expect(app.reminders.get(b.ownerId, r.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(app.reminders.reschedule(b.ownerId, r.id, 1, '2026-10-17T09:00')).rejects.toMatchObject({ code: 'not_found' });
    await expect(app.reminders.cancel(b.ownerId, r.id, 1)).rejects.toMatchObject({ code: 'not_found' });
    expect(await app.reminders.listActive(b.ownerId)).toEqual([]);
    expect((await app.reminders.get(a.ownerId, r.id)).scheduleVersion).toBe(1);
    await app.close();
  });
  it('ciphertext copied across owners does not decrypt (AAD binds the owner)', async () => {
    const app = mk();
    const task = await app.tasks.create(app.db, a.ownerId, { title: 'Top secret' });
    const raw = (await t.db.query<{ title_enc: string }>('SELECT title_enc FROM tasks WHERE id=$1', [task.id])).rows[0]!.title_enc;
    await t.db.query(`INSERT INTO tasks (owner_id, title_enc) VALUES ($1,$2)`, [b.ownerId, raw]); // attacker with DB write access copies the blob
    await expect(app.tasks.list(app.db, b.ownerId)).rejects.toThrow(/decryption failed/);
    await app.close();
  });
  it('contacts / permissions / call requests / authorizations / reports', async () => {
    const app = mk();
    const c = await app.contacts.create(
      app.db,
      a.ownerId,
      { telegramUserId: '555000111', displayName: 'Javlon', verificationSource: 'owner_confirmed_numeric_id' },
      app.clock.now(),
    );
    await expect(
      app.contacts.grant(app.db, b.ownerId, c.id, { allowCall: true, topicScopes: ['x'], expiresAt: new Date('2026-12-01T00:00:00Z') }, app.clock.now()),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(app.contacts.revoke(app.db, b.ownerId, c.id, app.clock.now())).rejects.toMatchObject({ code: 'not_found' });
    await app.contacts.grant(
      app.db,
      a.ownerId,
      c.id,
      { allowCall: true, topicScopes: ['credit-workflow'], expiresAt: new Date('2026-12-01T00:00:00Z') },
      app.clock.now(),
    );
    const body: CallPlanBody = {
      callRequestId: crypto.randomUUID(),
      ownerId: a.ownerId,
      recipientTelegramId: '555000111',
      topic: 'credit-workflow',
      purpose: 'check status please',
      questions: [],
      allowedContext: [],
      forbiddenCommitments: [],
      language: 'en',
      maxDurationSeconds: 60,
      expiresAt: '2026-10-15T09:00:00.000Z',
    };
    // B cannot create a plan that names A's owner id, nor call A's contact by numeric id (B has no such contact).
    await expect(app.authorizations.createCallRequest(b.ownerId, body)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(app.authorizations.createCallRequest(b.ownerId, { ...body, ownerId: b.ownerId })).rejects.toMatchObject({ code: 'not_found' });
    const req = await app.authorizations.createCallRequest(a.ownerId, body);
    await expect(app.authorizations.approve(b.ownerId, req.authorizationId, req.planHash)).rejects.toMatchObject({ code: 'not_found' });
    const stillPending = await t.db.query('SELECT state FROM authorizations WHERE id=$1', [req.authorizationId]);
    expect(stillPending.rows[0].state).toBe('pending');
    // B's dial attempt on A's request resolves to nothing.
    expect(await app.orchestrator.dial(b.ownerId, req.callRequestId)).toMatchObject({ status: 'rejected', reason: 'call_request_not_found' });
    await app.close();
  });
  it("intake: B's messages never reach A's numbered lists, and A's id from B's account is denied", async () => {
    const app = mk();
    await app.tasks.create(app.db, a.ownerId, { title: 'A task' });
    const send = (who: SeededOwner, text: string, i: number) =>
      app.intake.handle({
        accountId: who.accountId,
        updateKey: `k${i}`,
        providerMessageId: `m${i}`,
        senderTelegramId: who.telegramUserId,
        chat: { type: 'private', id: who.telegramUserId },
        receivedAt: new Date('2026-10-15T05:00:00Z'),
        text,
      });
    await send(a, 'my tasks', 1);
    expect(await send(b, 'done 1', 2)).toMatchObject({ status: 'handled' }); // B's own (empty) context: refused, not A's list
    expect((await t.db.query(`SELECT status FROM tasks WHERE owner_id=$1`, [a.ownerId])).rows[0].status).toBe('open');
    // A's numeric id arriving on B's assistant account is not valid authentication.
    expect(
      await app.intake.handle({
        accountId: b.accountId,
        updateKey: 'k9',
        providerMessageId: 'm9',
        senderTelegramId: a.telegramUserId,
        chat: { type: 'private', id: a.telegramUserId },
        receivedAt: new Date(),
        text: 'add task x',
      }),
    ).toEqual({ status: 'denied', reason: 'account_mismatch' });
    await app.close();
  });
});
