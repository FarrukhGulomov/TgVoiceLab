import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../support/test-db.js';
import { seedContact, seedOwner, type SeededOwner } from '../support/seed.js';
import { FakeClock } from '../../apps/assistant/src/application/clock.js';
import { ActiveCallRegistry, OperationsService } from '../../apps/assistant/src/modules/operations/operations.service.js';

/** Audit (2026-10-24) F-01 / F-08: a committed stop must end live calls even when the first hangup fails. */
let t: TestDb;
let o: SeededOwner;
let registry: ActiveCallRegistry;
let ops: OperationsService;
const clock = new FakeClock(new Date('2026-10-24T08:00:00Z'));

/** A live call whose hangup fails `failures` times and then works. */
const live = (callId: string, over: Partial<{ contactId: string | null; kind: 'owner_call' | 'contact_call'; inbound: boolean; failures: number }> = {}) => {
  const log: string[] = [];
  let left = over.failures ?? 0;
  registry.add({
    callId,
    ownerId: o.ownerId,
    contactId: over.contactId ?? null,
    kind: over.kind ?? 'owner_call',
    ...(over.inbound ? { inbound: true } : {}),
    end: async (reason) => {
      if (left-- > 0) throw new Error('hangup failed');
      log.push(reason);
    },
  });
  return log;
};

beforeEach(async () => {
  t = await createTestDb();
  o = await seedOwner(t.db);
  registry = new ActiveCallRegistry();
  ops = new OperationsService(t.db, clock, registry, { retryDelayMs: 1 });
});
afterEach(async () => {
  await t.drop();
});

describe('terminateLive', () => {
  it('retries a failing hangup and succeeds when a later attempt works', async () => {
    const log = live('c1', { failures: 2 });
    expect(await ops.terminateLive(o.ownerId, undefined, 'cancelled')).toBe(1);
    expect(log).toEqual(['cancelled']);
  });

  it('tries every matching call even when an earlier one keeps failing, then reports the failure', async () => {
    const stuck = live('c1', { failures: 99 });
    const fine = live('c2');
    await expect(ops.terminateLive(o.ownerId, undefined, 'cancelled')).rejects.toThrow(/could not end 1 live call/);
    expect(stuck).toEqual([]);
    expect(fine).toEqual(['cancelled']); // the second call was not left unprocessed
  });

  it('terminateCall retries one call and says whether it was live', async () => {
    const log = live('c1', { failures: 1 });
    expect(await ops.terminateCall(o.ownerId, 'c1', 'cancelled')).toBe(true);
    expect(log).toEqual(['cancelled']);
    expect(await ops.terminateCall(o.ownerId, 'nope', 'cancelled')).toBe(false);
  });
});

describe('enforceLivePolicy: live calls converge to the committed policy', () => {
  it('a kill switch committed while the hangup failed is enforced by the next sweep', async () => {
    const log = live('c1', { failures: 1 });
    await ops.applyKillSwitch(t.db, o.ownerId, true, 'drill'); // committed
    expect(await ops.enforceLivePolicy(o.ownerId)).toBe(0); // the hangup failed once: nothing ended yet, no throw
    expect(log).toEqual([]);
    expect(await ops.enforceLivePolicy(o.ownerId)).toBe(1); // the next sweep ends it
    expect(log).toEqual(['cancelled']);
  });

  it('does nothing while the policy allows the call', async () => {
    const log = live('c1');
    await ops.applyKillSwitch(t.db, o.ownerId, false, 'ok');
    expect(await ops.enforceLivePolicy(o.ownerId)).toBe(0);
    expect(log).toEqual([]);
  });

  it('"stop calling me" ends calls the assistant started but not a call the owner made to the assistant', async () => {
    await ops.applyKillSwitch(t.db, o.ownerId, false, 'ok');
    await t.db.query('UPDATE owners SET call_opt_out=true WHERE id=$1', [o.ownerId]);
    const outbound = live('out', { kind: 'owner_call' });
    const contact = live('contact', { kind: 'contact_call', contactId: await seedContact(t.db, o.ownerId) });
    const inbound = live('in', { kind: 'owner_call', inbound: true });
    await ops.enforceLivePolicy(o.ownerId);
    expect(outbound).toEqual(['cancelled']);
    expect(contact).toEqual(['cancelled']);
    expect(inbound).toEqual([]);
  });

  it('a contact call whose permission was revoked is ended as consent_withdrawn', async () => {
    await ops.applyKillSwitch(t.db, o.ownerId, false, 'ok');
    const contactId = await seedContact(t.db, o.ownerId);
    await t.db.query(
      `INSERT INTO contact_permissions (owner_id, contact_id, version, allow_call, topic_scopes, expires_at, revoked_at) VALUES ($1,$2,1,true,'{x}','2027-01-01',$3)`,
      [o.ownerId, contactId, new Date('2026-10-24T07:00:00Z')],
    );
    const log = live('c1', { kind: 'contact_call', contactId });
    expect(await ops.enforceLivePolicy(o.ownerId)).toBe(1);
    expect(log).toEqual(['consent_withdrawn']);
  });
});
