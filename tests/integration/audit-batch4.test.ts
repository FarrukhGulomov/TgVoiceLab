import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestDb, type TestDb } from '../support/test-db.js';
import { seedOwner, type SeededOwner } from '../support/seed.js';
import { boot } from '../support/harness.js';
import { FakeClock } from '../../apps/assistant/src/application/clock.js';
import { buildServer } from '../../apps/assistant/src/http/server.js';
import { createLogger } from '../../apps/assistant/src/infrastructure/observability/logger.js';
import { Envelope, parseKeyRing } from '../../apps/assistant/src/infrastructure/crypto/envelope.js';
import { rotateKeys } from '../../apps/assistant/src/modules/retention/rotate-keys.js';

/** Audit F10: encryption must not be bypassed by plaintext copies (idempotency responses, call plans, permission context). */
const TOKEN = 'T'.repeat(40);
const PH = 'ZEBRA-QUARTZ-7731'; // distinctive synthetic phrase: no real data in fixtures
let t: TestDb;
let o: SeededOwner;
let app: ReturnType<typeof boot>;
let srv: FastifyInstance;
let clock: FakeClock;
let k = 0;
beforeEach(async () => {
  t = await createTestDb();
  o = await seedOwner(t.db);
  clock = new FakeClock(new Date('2026-10-15T06:00:00Z'));
  app = boot(t.url, clock);
  srv = await buildServer({
    app,
    log: createLogger('silent'),
    adminTokens: [TOKEN],
    runtime: {
      messagingAdapter: 'fake',
      interpreterAdapter: 'rules',
      callAdapter: 'disabled',
      evidencePath: null,
      buildFingerprint: 'x'.repeat(64),
      transcription: false,
    },
  });
});
afterEach(async () => {
  await srv.close();
  await app.close();
  await t.drop();
});
const api = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, key = `key-${++k}-${Math.random().toString(36).slice(2)}`) =>
  srv.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as object } : {}),
    headers: { authorization: `Bearer ${TOKEN}`, ...(method !== 'GET' ? { 'idempotency-key': key } : {}) },
  });

/** Every row of every table as text: what a stolen database dump would contain. */
async function dump(): Promise<string> {
  const tables = (
    await t.db.query<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`)
  ).rows;
  let all = '';
  for (const { t: name } of tables) all += (await t.db.query<{ r: string }>(`SELECT x::text AS r FROM "${name}" x`)).rows.map((r) => r.r).join('\n');
  return all;
}

async function populate() {
  const contact = await api('POST', '/v1/contacts', { telegramUserId: '555000111', displayName: 'Javlon' });
  const contactId = contact.json().data.id;
  await api('PATCH', `/v1/contacts/${contactId}/permissions`, {
    allowCall: true,
    topicScopes: ['credit-workflow'],
    contextAllowlist: [`${PH} context entry`],
    expiresAt: '2026-12-01T00:00:00Z',
  });
  const task = await api('POST', '/v1/tasks', { title: `${PH} task title`, description: `${PH} task description` }, 'fixed-task-key-1');
  await api('POST', '/v1/reminders', { title: `${PH} reminder`, localDateTime: '2026-10-16T09:00' });
  const call = await api('POST', '/v1/call-requests', {
    recipientTelegramId: '555000111',
    topic: 'credit-workflow',
    purpose: `${PH} purpose`,
    questions: [`${PH} question?`],
    allowedContext: [`${PH} allowed context`],
    forbiddenCommitments: [`${PH} forbidden commitment`],
    language: 'en',
    maxDurationSeconds: 300,
    expiresAt: '2026-10-15T09:00:00.000Z',
  });
  return { contactId, task, call };
}

describe('F10 — no sensitive plaintext survives in any table', () => {
  it('a distinctive private phrase is absent from a raw dump of every table, yet authorized reads and replays still work', async () => {
    const { task, call } = await populate();
    expect(task.statusCode).toBe(201);
    expect(call.statusCode).toBe(202);
    await app.tick(); // delivers outbox confirmations
    const text = await dump();
    expect(text).not.toContain(PH);
    // Authorized replay still returns the original (decrypted) response.
    const replay = await api('POST', '/v1/tasks', { title: `${PH} task title`, description: `${PH} task description` }, 'fixed-task-key-1');
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json().data.title).toBe(`${PH} task title`);
    // Normal reads decrypt.
    expect((await api('GET', '/v1/tasks')).json().data[0].title).toBe(`${PH} task title`);
  });
  it('the exact-plan check still works: the call plan the orchestrator loads equals what the owner approved', async () => {
    const { call } = await populate();
    const planHash = call.json().data.planHash as string;
    const row = (await t.db.query('SELECT plan, plan_enc FROM call_requests')).rows[0];
    expect(JSON.stringify(row.plan)).not.toContain('purpose'); // shell has no free text
    expect(row.plan_enc).toMatch(/^e1\./);
    const loaded = await app.orchestrator.loadInput(t.db, o.ownerId, call.json().data.callRequestId, { budgetReserved: true });
    expect(loaded?.plan.purpose).toBe(`${PH} purpose`);
    expect(loaded?.plan.planHash).toBe(planHash);
  });
  it('key rotation re-encrypts the new ciphertext locations too', async () => {
    const k2 = randomBytes(32).toString('base64');
    await populate();
    const stale = (await t.db.query<{ plan_enc: string }>('SELECT plan_enc FROM call_requests')).rows[0]!.plan_enc;
    expect(stale.startsWith('e1.k1.')).toBe(true);
    const keys = JSON.parse((await import('../support/harness.js')).TEST_KEYRING) as { keys: Record<string, string> };
    const env = new Envelope(parseKeyRing(JSON.stringify({ active: 'k2', keys: { ...keys.keys, k2 } })));
    const r = await rotateKeys(t.db, env);
    expect(r.remainingOnOldKeys).toBe(0);
    expect((await t.db.query<{ plan_enc: string }>('SELECT plan_enc FROM call_requests')).rows[0]!.plan_enc.startsWith('e1.k2.')).toBe(true);
    const ctx = (await t.db.query<{ c: string[] }>('SELECT context_allowlist AS c FROM contact_permissions WHERE allow_call')).rows[0]!.c;
    expect(ctx.every((x) => x.startsWith('e1.k2.'))).toBe(true);
  });
});

describe('F10 — legacy plaintext written before sealing is backfilled idempotently', () => {
  it('seals old call plans, authorization plans, permission context and idempotency responses; second run is a no-op', async () => {
    const { contactId } = await populate();
    // Simulate a pre-fix database: put clear text back exactly as the old code stored it.
    const plain = {
      callRequestId: globalThis.crypto.randomUUID(),
      purpose: `${PH} legacy purpose`,
      questions: [`${PH} q`],
      allowedContext: [`${PH} c`],
      forbiddenCommitments: [`${PH} f`],
    };
    await t.db.query(`UPDATE authorizations SET plan = plan || $1::jsonb`, [JSON.stringify(plain)]);
    await t.db.query(`UPDATE contact_permissions SET context_allowlist = ARRAY['${PH} legacy context'] WHERE contact_id=$1`, [contactId]);
    await t.db.query(
      `INSERT INTO idempotency_keys (owner_id, action, key, request_hash, state, status_code, response, expires_at) VALUES ($1,'a','legacy-k','h','done',200,$2::jsonb, now() + interval '1 day')`,
      [o.ownerId, JSON.stringify({ data: { title: `${PH} legacy response` } })],
    );
    const { sealLegacyPlaintext } = await import('../../apps/assistant/src/modules/retention/seal-legacy.js');
    const first = await sealLegacyPlaintext(app.db, app.crypto);
    expect(first.authorizations).toBe(1);
    expect(first.permissions).toBeGreaterThanOrEqual(1);
    expect(first.idempotency).toBe(1);
    expect(await dump()).not.toContain(PH);
    expect(await sealLegacyPlaintext(app.db, app.crypto)).toEqual({ plans: 0, authorizations: 0, permissions: 0, idempotency: 0 });
  });
});
