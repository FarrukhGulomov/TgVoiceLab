import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../support/test-db.js';
import { seedOwner, type SeededOwner } from '../support/seed.js';
import { boot } from '../support/harness.js';
import { FakeClock } from '../../apps/assistant/src/application/clock.js';
import { FakeCallAdapter, FakeMessaging } from '../../apps/assistant/src/testing/fakes.js';
import type { DerivedCapabilities } from '../../apps/assistant/src/modules/calls/capability-evidence.js';
import { ensureDailyBudget } from '../../apps/assistant/src/modules/operations/operations.service.js';

/** A reminder set "by call" rings the OWNER when it fires; the dial policy still decides. FAKE adapter only. */
const ALL_PASS: DerivedCapabilities = {
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
// Thu 2026-10-15 11:00 Samarkand. The reminder is due at 12:00 local = 07:00Z.
const START = '2026-10-15T06:00:00Z';
const DUE = '2026-10-15T07:00:00Z';
let t: TestDb;
let o: SeededOwner;
beforeEach(async () => {
  t = await createTestDb();
  o = await seedOwner(t.db);
});
afterEach(async () => {
  await t.drop();
});

async function setup(opts: { callsEnabled?: boolean } = {}) {
  const clock = new FakeClock(new Date(START));
  const adapter = new FakeCallAdapter();
  const app = boot(t.url, clock, new FakeMessaging(), 'w', {
    callAdapter: adapter,
    deriveCapabilities: () => ALL_PASS,
    callsEnabled: opts.callsEnabled ?? true,
  });
  await app.operations.setKillSwitch(o.ownerId, false, 'test');
  await ensureDailyBudget(t.db, o.ownerId, '2026-10-15', 5_000_000);
  const texts = () => app.messaging.sent.map((m) => m.text);
  return { clock, adapter, app, texts };
}

describe('call-mode reminders', () => {
  it("queue an owner call (approved by the owner's own instruction), send the text at once, and dial through the normal policy path", async () => {
    const s = await setup();
    await s.app.reminders.create(o.ownerId, { title: 'Dori ichish', localDateTime: '2026-10-15T12:00', mode: 'call' });
    s.clock.set(DUE);
    await s.app.tick(); // fires the reminder (jobs lane), queues the call and dials it (calls lane)
    expect(s.texts()).toContain('⏰ Reminder: Dori ichish\n(I am calling you now as well.)');
    const req = await t.db.query(`SELECT status, contact_id FROM call_requests`);
    expect(req.rows).toHaveLength(1);
    expect(req.rows[0].contact_id).toBeNull(); // an owner call: no contact row
    const auth = await t.db.query(`SELECT action, state FROM authorizations`);
    expect(auth.rows).toEqual([{ action: 'owner_call', state: expect.stringMatching(/approved|consumed/) }]);
    // the plan is sealed: the reminder text is not stored in the clear
    const raw = JSON.stringify((await t.db.query(`SELECT plan, plan_enc FROM call_requests`)).rows);
    expect(raw).not.toContain('Dori ichish');
    // it reached the (fake) adapter through the normal policy path, addressed to the owner only
    expect(s.adapter.dials).toHaveLength(1);
    expect(s.adapter.dials[0]).toMatchObject({ topic: 'reminder', recipientTelegramId: o.telegramUserId, maxDurationSeconds: 120 });
    expect((await t.db.query(`SELECT allowed, reason_code FROM audit_events WHERE action='call.dial'`)).rows).toEqual([{ allowed: true, reason_code: 'ok' }]);
    // this harness has no conversation runner, so the call ends at once; the owner is told once, in plain words
    expect(s.texts().filter((x) => x.includes('reminder call to you did not go through'))).toHaveLength(1);
    await s.app.close();
  });

  it('degrade to the message-only notice when calling is switched off, exactly as before', async () => {
    const s = await setup({ callsEnabled: false });
    await s.app.reminders.create(o.ownerId, { title: 'Dori ichish', localDateTime: '2026-10-15T12:00', mode: 'call' });
    s.clock.set(DUE);
    await s.app.tick();
    expect(s.texts().at(-1)).toContain('calls are not available right now');
    expect((await t.db.query('SELECT count(*)::int n FROM call_requests')).rows[0].n).toBe(0);
    await s.app.close();
  });

  it('never ring an owner who said "stop calling me"', async () => {
    const s = await setup();
    await s.app.reminders.create(o.ownerId, { title: 'Dori ichish', localDateTime: '2026-10-15T12:00', mode: 'call' });
    await t.db.query('UPDATE owners SET call_opt_out=true WHERE id=$1', [o.ownerId]);
    s.clock.set(DUE);
    await s.app.tick();
    expect(s.texts().at(-1)).toContain('calls are not available right now'); // the message still arrives
    expect((await t.db.query('SELECT count(*)::int n FROM call_requests')).rows[0].n).toBe(0);
    expect(s.adapter.dials).toHaveLength(0);
    await s.app.close();
  });

  it('a reminder that is already more than 5 minutes late is a message, not a surprise call', async () => {
    const s = await setup();
    await s.app.reminders.create(o.ownerId, { title: 'Dori ichish', localDateTime: '2026-10-15T12:00', mode: 'call' });
    s.clock.set('2026-10-15T07:30:00Z');
    await s.app.tick();
    expect(s.texts().at(-1)).toContain('was missed');
    expect((await t.db.query('SELECT count(*)::int n FROM call_requests')).rows[0].n).toBe(0);
    await s.app.close();
  });

  it('a call refused by the policy (quiet hours) tells the owner once, and the reminder text was already delivered', async () => {
    const s = await setup();
    await t.db.query(`UPDATE owners SET quiet_hours=$2 WHERE id=$1`, [o.ownerId, JSON.stringify({ enabled: true, start: '11:30', end: '13:00' })]);
    await s.app.reminders.create(o.ownerId, { title: 'Dori ichish', localDateTime: '2026-10-15T12:00', mode: 'call' });
    s.clock.set(DUE);
    await s.app.tick();
    await s.app.tick();
    await s.app.tick();
    expect(s.adapter.dials).toHaveLength(0);
    const all = s.texts();
    expect(all.some((x) => x.startsWith('⏰ Reminder: Dori ichish'))).toBe(true);
    expect(all.filter((x) => x.includes('reminder call to you did not go through'))).toHaveLength(1);
    expect(all.join('\n')).not.toContain('?');
    await s.app.close();
  });

  it('"remind me by call ..." in chat stores a call-mode reminder and the confirmation says what will happen', async () => {
    const s = await setup();
    await s.app.intake.handle({
      accountId: o.accountId,
      updateKey: 'msg:bycall-1',
      providerMessageId: '1',
      senderTelegramId: o.telegramUserId,
      chat: { type: 'private', id: o.telegramUserId },
      receivedAt: s.clock.now(),
      text: 'remind me by call today at 12:00 to take the medicine',
    });
    await s.app.tick();
    expect((await t.db.query(`SELECT mode FROM reminders`)).rows).toEqual([{ mode: 'call' }]);
    const confirm = s.texts().find((x) => x.startsWith('Reminder set'));
    expect(confirm).toContain('take the medicine');
    expect(confirm).toContain('I will call you at that time');
    expect(confirm).not.toMatch(/by call/); // the wish is not part of the title
    // a plain reminder says nothing about calls
    await s.app.intake.handle({
      accountId: o.accountId,
      updateKey: 'msg:bycall-2',
      providerMessageId: '2',
      senderTelegramId: o.telegramUserId,
      chat: { type: 'private', id: o.telegramUserId },
      receivedAt: s.clock.now(),
      text: 'remind me today at 12:30 to drink water',
    });
    await s.app.tick();
    expect(s.texts().find((x) => x.includes('drink water') && x.startsWith('Reminder set'))).not.toContain('call you');
    await s.app.close();
  });
});
