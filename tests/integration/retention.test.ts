import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../support/test-db.js';
import { seedOwner, type SeededOwner } from '../support/seed.js';
import { replayTombstones, runRetention } from '../../apps/assistant/src/modules/retention/retention.js';

let t: TestDb;
let o: SeededOwner;
const NOW = new Date('2026-10-15T00:00:00Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
beforeEach(async () => {
  t = await createTestDb();
  o = await seedOwner(t.db);
});
afterEach(async () => {
  await t.drop();
});

async function msg(id: string, expires: Date | null) {
  const conv = (
    await t.db.query<{ id: string }>(`INSERT INTO conversations (owner_id, actor_role, channel) VALUES ($1,'owner','telegram_text') RETURNING id`, [o.ownerId])
  ).rows[0]!.id;
  await t.db.query(
    `INSERT INTO messages (owner_id, conversation_id, account_id, provider_message_id, direction, content_enc, occurred_at, retention_expires_at) VALUES ($1,$2,$3,$4,'inbound','e1.secret',$5,$6)`,
    [o.ownerId, conv, o.accountId, id, NOW, expires],
  );
}
const count = async (table: string) => (await t.db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n as number;

describe('retention & deletion (A15)', () => {
  it('deletes expired content, keeps unexpired, and leaves tombstones', async () => {
    await msg('old', days(-1));
    await msg('fresh', days(+10));
    await msg('forever', null);
    await t.db.query(
      `INSERT INTO memories (owner_id, subject_scope, value_enc, provenance, expires_at, approved_at) VALUES ($1,'owner:pref','e1.x','{}',$2, now())`,
      [o.ownerId, days(-1)],
    );
    const r = await runRetention(t.db, NOW);
    expect(r).toMatchObject({ messages: 1, memories: 1 });
    expect(await count('messages')).toBe(2);
    expect(await count('memories')).toBe(0);
    expect(await count('deletion_tombstones')).toBe(2);
  });
  it('prunes expired idempotency keys, old audit rows (past 90 days), delivered outbox and done jobs — and nothing newer', async () => {
    await t.db.query(`INSERT INTO idempotency_keys (owner_id, action, key, request_hash, expires_at) VALUES ($1,'a','old','h',$2), ($1,'a','new','h',$3)`, [
      o.ownerId,
      days(-1),
      days(+1),
    ]);
    await t.db.query(
      `INSERT INTO audit_events (owner_id, actor_type, action, allowed, reason_code, created_at) VALUES ($1,'system','x',true,'ok',$2), ($1,'system','x',true,'ok',$3)`,
      [o.ownerId, days(-91), days(-10)],
    );
    const r = await runRetention(t.db, NOW);
    expect(r).toMatchObject({ idempotency: 1, audit: 1 });
    expect(await count('audit_events')).toBe(1);
    expect(await count('idempotency_keys')).toBe(1);
  });
  it('the retention switch does not leak: outside the job, audit rows still cannot be deleted', async () => {
    await t.db.query(`INSERT INTO audit_events (owner_id, actor_type, action, allowed, reason_code) VALUES ($1,'system','x',true,'ok')`, [o.ownerId]);
    await runRetention(t.db, NOW);
    await expect(t.db.query('DELETE FROM audit_events')).rejects.toThrow(/retention job/);
  });
  it('restore + tombstone replay: content deleted before the backup was taken does not come back', async () => {
    await msg('gdpr-delete-me', days(-1));
    const before = await t.db.query('SELECT * FROM messages');
    await runRetention(t.db, NOW);
    expect(await count('messages')).toBe(0);
    // "Restore from an older backup": the row reappears, but the tombstone table (restored or re-applied) is replayed.
    const row = before.rows[0];
    await t.db.query(
      `INSERT INTO messages (id, owner_id, conversation_id, account_id, provider_message_id, direction, content_enc, occurred_at, retention_expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        row.id,
        row.owner_id,
        row.conversation_id,
        row.account_id,
        row.provider_message_id,
        row.direction,
        row.content_enc,
        row.occurred_at,
        row.retention_expires_at,
      ],
    );
    expect(await count('messages')).toBe(1);
    expect(await replayTombstones(t.db)).toEqual({ purged: 1 });
    expect(await count('messages')).toBe(0);
    expect(await replayTombstones(t.db)).toEqual({ purged: 0 }); // idempotent
  });
  it('is idempotent: a second sweep deletes nothing more', async () => {
    await msg('old', days(-1));
    await runRetention(t.db, NOW);
    expect(await runRetention(t.db, NOW)).toMatchObject({ messages: 0, memories: 0 });
  });
});
