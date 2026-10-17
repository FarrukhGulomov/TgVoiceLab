import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../support/test-db.js';
import { seedOwner, type SeededOwner } from '../support/seed.js';
import { boot } from '../support/harness.js';
import { FakeClock } from '../../apps/assistant/src/application/clock.js';
import {
  OwnerCallTools,
  buildOwnerCallInstructions,
  OWNER_CALL_TOOL_DECLARATIONS,
} from '../../apps/assistant/src/modules/calls/conversation/owner-call-tools.js';

let t: TestDb;
let o: SeededOwner;
// Asia/Samarkand is UTC+5: 2026-10-16 09:00 local = 04:00Z
const NOW = '2026-10-16T04:00:00Z';
beforeEach(async () => {
  t = await createTestDb();
  o = await seedOwner(t.db);
});
afterEach(async () => {
  await t.drop();
});

async function setup() {
  const clock = new FakeClock(new Date(NOW));
  const app = boot(t.url, clock);
  const overdue = await app.tasks.create(app.db, o.ownerId, { title: 'Hisobotni yuborish', dueAt: new Date('2026-10-14T05:00:00Z') });
  const today = await app.tasks.create(app.db, o.ownerId, { title: 'Bankka qo‘ng‘iroq', dueAt: new Date('2026-10-16T10:00:00Z') });
  const future = await app.tasks.create(app.db, o.ownerId, { title: 'Keyingi hafta ishi', dueAt: new Date('2026-10-22T05:00:00Z') });
  const ended: string[] = [];
  const tools = new OwnerCallTools({
    db: app.db,
    tasks: app.tasks,
    clock,
    ownerId: o.ownerId,
    timezone: 'Asia/Samarkand',
    onEndCall: () => void ended.push('end'),
  });
  await tools.load();
  const run = (name: string, args: Record<string, unknown> = {}) => tools.execute({ id: 'x', name, args });
  const status = async (id: string) => (await t.db.query('SELECT status, due_at FROM tasks WHERE id=$1', [id])).rows[0] as { status: string; due_at: Date };
  return { app, tools, run, overdue, today, future, ended, status };
}

describe('owner call tools (authenticated owner call)', () => {
  it('numbers overdue and due-today tasks, leaves later tasks out', async () => {
    const s = await setup();
    expect(s.tools.describeList()).toEqual([
      { number: 1, title: 'Hisobotni yuborish', due: '2026-10-14 10:00' },
      { number: 2, title: 'Bankka qo‘ng‘iroq', due: '2026-10-16 15:00' },
    ]);
    expect((await s.run('list_tasks')).result).toEqual({ tasks: s.tools.describeList() });
    await s.app.close();
  });

  it('complete_task commits before it reports ok, audits the action, and is idempotent', async () => {
    const s = await setup();
    expect((await s.run('complete_task', { number: 2 })).result).toEqual({ ok: true, title: 'Bankka qo‘ng‘iroq', alreadyDone: false });
    expect((await s.status(s.today.id)).status).toBe('done');
    expect((await s.run('complete_task', { number: 2 })).result).toEqual({ ok: true, title: 'Bankka qo‘ng‘iroq', alreadyDone: true });
    const audit = await t.db.query(`SELECT metadata, allowed FROM audit_events WHERE action='task.complete'`);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].metadata).toMatchObject({ channel: 'owner_call' });
    await s.app.close();
  });

  it('an unknown or non-numeric task number changes nothing and says so', async () => {
    const s = await setup();
    for (const n of [0, 3, 99, -1, 1.5, '1', null, undefined]) {
      const r = (await s.run('complete_task', { number: n })).result as { ok: boolean; error: string };
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/there is no task number/);
    }
    expect((await s.status(s.overdue.id)).status).toBe('open');
    expect((await s.status(s.today.id)).status).toBe('open');
    await s.app.close();
  });

  it('move_task validates the date and time, refuses the past, and reports the exact new due date', async () => {
    const s = await setup();
    const r = (await s.run('move_task', { number: 1, date: '2026-10-17', time: '10:30' })).result;
    expect(r).toEqual({ ok: true, title: 'Hisobotni yuborish', newDue: '2026-10-17 10:30 (Asia/Samarkand)' });
    expect((await s.status(s.overdue.id)).due_at.toISOString()).toBe('2026-10-17T05:30:00.000Z');
    // default time when none is given
    expect(((await s.run('move_task', { number: 2, date: '2026-10-18' })).result as { newDue: string }).newDue).toBe('2026-10-18 18:00 (Asia/Samarkand)');
    // rejected inputs never touch the task
    for (const args of [
      { number: 2, date: '2026-10-15' }, // past
      { number: 2, date: 'ertaga' },
      { number: 2, date: '2026-13-40' },
      { number: 2, date: '2026-10-20', time: '25:00' },
    ])
      expect(((await s.run('move_task', args)).result as { ok: boolean }).ok).toBe(false);
    expect((await s.status(s.today.id)).due_at.toISOString()).toBe('2026-10-18T13:00:00.000Z'); // still the earlier valid move
    await s.app.close();
  });

  it('end_call asks for a hang-up after playout and does not make the model speak again; unknown tools are errors', async () => {
    const s = await setup();
    const out = await s.run('end_call', { reason: 'bye' });
    expect(out.respond).toBe(false);
    expect(s.ended).toEqual([]); // only after playout
    await out.afterPlayout!();
    expect(s.ended).toEqual(['end']);
    expect((await s.run('delete_everything')).result).toEqual({ error: 'unknown tool delete_everything' });
    await s.app.close();
  });

  it('no tool takes an owner, account or permission argument', () => {
    const props = OWNER_CALL_TOOL_DECLARATIONS.flatMap((d) => Object.keys((d.parameters as { properties: object }).properties));
    expect(props.filter((p) => /owner|account|user|permission|id$/i.test(p))).toEqual([]);
  });

  it('instructions carry the app-supplied local time and the list as data, with the confirm-only-after-ok rule', async () => {
    const s = await setup();
    const text = buildOwnerCallInstructions({ now: new Date(NOW), timezone: 'Asia/Samarkand', tasks: s.tools.describeList() });
    expect(text).toContain('2026-10-16 09:00 (Asia/Samarkand)');
    expect(text).toContain('1. Hisobotni yuborish (muddati: 2026-10-14 10:00)');
    expect(text).toContain('ok: true');
    expect(text).toContain("MA'LUMOT");
    await s.app.close();
  });
});
