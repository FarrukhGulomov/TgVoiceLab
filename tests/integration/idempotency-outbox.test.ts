import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../support/test-db.js';
import { seedOwner, type SeededOwner } from '../support/seed.js';
import { runIdempotent } from '../../apps/assistant/src/modules/idempotency/idempotency.js';
import { dispatchOutboxOnce, emitOutbox } from '../../apps/assistant/src/modules/outbox/outbox.js';

let t: TestDb;
let o: SeededOwner;
const NOW = new Date('2026-10-15T10:00:00Z');
beforeAll(async () => {
  t = await createTestDb();
  o = await seedOwner(t.db);
});
afterAll(async () => {
  await t.drop();
});

const createTask = (title: string) => async (c: any) => {
  const r = await c.query(`INSERT INTO tasks (owner_id, title_enc) VALUES ($1,$2) RETURNING id`, [o.ownerId, `e1.${title}`]);
  return { status: 201, body: { id: r.rows[0].id as string } };
};
const taskCount = async () => (await t.db.query('SELECT count(*)::int AS n FROM tasks WHERE owner_id=$1', [o.ownerId])).rows[0].n as number;

describe('idempotency keys', () => {
  it('replays the stored response and performs the mutation once', async () => {
    const before = await taskCount();
    const args = { ownerId: o.ownerId, action: 'tasks.create', key: 'k-replay', requestBody: { title: 'A' }, now: NOW };
    const r1 = await runIdempotent(t.db, args, createTask('A'));
    const r2 = await runIdempotent(t.db, args, createTask('A'));
    expect(r1.kind).toBe('executed');
    expect(r2.kind).toBe('replayed');
    expect(r2.kind === 'replayed' && r2.body).toEqual(r1.kind === 'executed' && r1.body);
    expect((await taskCount()) - before).toBe(1);
  });
  it('same key with a different body is a conflict (409) and does not mutate', async () => {
    const before = await taskCount();
    await runIdempotent(t.db, { ownerId: o.ownerId, action: 'tasks.create', key: 'k-conf', requestBody: { title: 'A' }, now: NOW }, createTask('A'));
    const r = await runIdempotent(
      t.db,
      { ownerId: o.ownerId, action: 'tasks.create', key: 'k-conf', requestBody: { title: 'DIFFERENT' }, now: NOW },
      createTask('DIFFERENT'),
    );
    expect(r.kind).toBe('conflict');
    expect((await taskCount()) - before).toBe(1);
  });
  it('body key order does not matter', async () => {
    const a = await runIdempotent(t.db, { ownerId: o.ownerId, action: 'x', key: 'k-order', requestBody: { a: 1, b: { c: 2, d: 3 } }, now: NOW }, async () => ({
      status: 200,
      body: {},
    }));
    const b = await runIdempotent(t.db, { ownerId: o.ownerId, action: 'x', key: 'k-order', requestBody: { b: { d: 3, c: 2 }, a: 1 }, now: NOW }, async () => ({
      status: 200,
      body: {},
    }));
    expect(a.kind).toBe('executed');
    expect(b.kind).toBe('replayed');
  });
  it('concurrent requests with the same key execute the handler exactly once', async () => {
    const before = await taskCount();
    const outs = await Promise.all(
      Array.from({ length: 10 }, () =>
        runIdempotent(t.db, { ownerId: o.ownerId, action: 'tasks.create', key: 'k-conc', requestBody: { title: 'C' }, now: NOW }, createTask('C')),
      ),
    );
    expect(outs.filter((x) => x.kind === 'executed')).toHaveLength(1);
    expect(outs.filter((x) => x.kind === 'replayed')).toHaveLength(9);
    expect((await taskCount()) - before).toBe(1);
  });
  it('a handler failure rolls back both the mutation and the key (client may retry)', async () => {
    const before = await taskCount();
    const args = { ownerId: o.ownerId, action: 'tasks.create', key: 'k-fail', requestBody: { title: 'F' }, now: NOW };
    await expect(
      runIdempotent(t.db, args, async (c) => {
        await createTask('F')(c);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await taskCount()).toBe(before);
    expect((await runIdempotent(t.db, args, createTask('F'))).kind).toBe('executed');
  });
  it('keys are scoped per owner', async () => {
    const o2 = await seedOwner(t.db);
    const a = await runIdempotent(t.db, { ownerId: o.ownerId, action: 'x', key: 'shared', requestBody: {}, now: NOW }, async () => ({
      status: 200,
      body: { who: 1 },
    }));
    const b = await runIdempotent(t.db, { ownerId: o2.ownerId, action: 'x', key: 'shared', requestBody: {}, now: NOW }, async () => ({
      status: 200,
      body: { who: 2 },
    }));
    expect([a.kind, b.kind]).toEqual(['executed', 'executed']);
  });
});

describe('transactional outbox', () => {
  it('is written atomically with the state change (rollback leaves nothing)', async () => {
    const before = (await t.db.query('SELECT count(*)::int AS n FROM outbox')).rows[0].n;
    await expect(
      t.db.tx(async (c) => {
        const r = await c.query(`INSERT INTO tasks (owner_id, title_enc) VALUES ($1,'e1.x') RETURNING id`, [o.ownerId]);
        await emitOutbox(c, { ownerId: o.ownerId, aggregateType: 'task', aggregateId: r.rows[0].id, type: 'task.created' }, NOW);
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect((await t.db.query('SELECT count(*)::int AS n FROM outbox')).rows[0].n).toBe(before);
  });

  it('delivers at least once: a failed handler is retried later with the same event id; success marks delivered', async () => {
    const id = await t.db.tx(async (c) => {
      const r = await c.query(`INSERT INTO tasks (owner_id, title_enc) VALUES ($1,'e1.y') RETURNING id`, [o.ownerId]);
      return emitOutbox(c, { ownerId: o.ownerId, aggregateType: 'task', aggregateId: r.rows[0].id, type: 'test.deliver' }, NOW);
    });
    const seen: string[] = [];
    let fail = true;
    const handlers = {
      'test.deliver': async (row: { eventId: string }) => {
        seen.push(row.eventId);
        if (fail) throw new Error('telegram 5xx');
      },
    };
    const r1 = await dispatchOutboxOnce(t.db, handlers, { workerId: 'w', now: NOW });
    expect(r1).toMatchObject({ delivered: 0, failed: 1 });
    // Backoff: not yet due.
    expect((await dispatchOutboxOnce(t.db, handlers, { workerId: 'w', now: new Date(NOW.getTime() + 100) })).failed).toBe(0);
    fail = false;
    const r2 = await dispatchOutboxOnce(t.db, handlers, { workerId: 'w', now: new Date(NOW.getTime() + 20 * 60_000) });
    expect(r2.delivered).toBe(1);
    expect(seen).toEqual([id, id]); // same eventId both times -> handler can dedupe
    const row = await t.db.query('SELECT delivery_state FROM outbox WHERE event_id=$1', [id]);
    expect(row.rows[0].delivery_state).toBe('delivered');
  });

  it('concurrent dispatchers deliver each event once', async () => {
    const ids = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        emitOutbox(t.db, { ownerId: o.ownerId, aggregateType: 'x', aggregateId: o.ownerId, type: 'test.conc', payload: { i } }, NOW),
      ),
    );
    const delivered: string[] = [];
    const handlers = {
      'test.conc': async (row: { eventId: string }) => {
        delivered.push(row.eventId);
      },
    };
    await Promise.all(Array.from({ length: 5 }, (_, w) => dispatchOutboxOnce(t.db, handlers, { workerId: `w${w}`, now: NOW, limit: 20 })));
    expect(delivered.sort()).toEqual([...ids].sort());
  });

  it('dead-letters after max attempts', async () => {
    const id = await emitOutbox(t.db, { ownerId: o.ownerId, aggregateType: 'x', aggregateId: o.ownerId, type: 'test.dead' }, NOW);
    let now = NOW;
    for (let i = 0; i < 4; i++) {
      await dispatchOutboxOnce(
        t.db,
        {
          'test.dead': async () => {
            throw new Error('nope');
          },
        },
        { workerId: 'w', now, maxAttempts: 3 },
      );
      now = new Date(now.getTime() + 20 * 60_000);
    }
    const row = await t.db.query('SELECT delivery_state, attempts FROM outbox WHERE event_id=$1', [id]);
    expect(row.rows[0]).toMatchObject({ delivery_state: 'dead', attempts: 3 });
  });
});
