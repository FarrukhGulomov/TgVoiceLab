import type { Db } from '../../apps/assistant/src/infrastructure/db/db.js';

export interface SeededOwner {
  ownerId: string;
  accountId: string;
  telegramUserId: string;
  assistantTelegramUserId: string;
}

let counter = 1_000_000;
export async function seedOwner(db: Db, overrides: { telegramUserId?: string; locale?: 'uz' | 'en' | 'ru' } = {}): Promise<SeededOwner> {
  const n = ++counter + Math.floor(Math.random() * 1e6);
  const telegramUserId = overrides.telegramUserId ?? String(10_000_000 + n);
  const assistantTelegramUserId = String(20_000_000 + n);
  const o = await db.query<{ id: string }>(`INSERT INTO owners (telegram_user_id, locale) VALUES ($1, $2) RETURNING id`, [
    telegramUserId,
    overrides.locale ?? 'en',
  ]);
  const ownerId = o.rows[0]!.id;
  const a = await db.query<{ id: string }>(
    `INSERT INTO telegram_accounts (owner_id, assistant_telegram_user_id, session_secret_ref, status) VALUES ($1,$2,'env:TEST_SESSION','active') RETURNING id`,
    [ownerId, assistantTelegramUserId],
  );
  await db.query(`INSERT INTO operation_settings (owner_id) VALUES ($1)`, [ownerId]);
  return { ownerId, accountId: a.rows[0]!.id, telegramUserId, assistantTelegramUserId };
}

export async function seedContact(db: Db, ownerId: string, telegramUserId = String(30_000_000 + Math.floor(Math.random() * 1e7))): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO contacts (owner_id, telegram_user_id, display_name, verified_at, verification_source) VALUES ($1,$2,'Javlon',now(),'owner_confirmed') RETURNING id`,
    [ownerId, telegramUserId],
  );
  return r.rows[0]!.id;
}

const HASH = 'a'.repeat(64);
/** Insert an authorization + call request ready for a calls row. */
export async function seedCallScaffold(db: Db, ownerId: string, contactId: string) {
  const auth = await db.query<{ id: string }>(
    `INSERT INTO authorizations (owner_id, action, target_contact_id, plan, plan_hash, state, expires_at, approved_at)
     VALUES ($1,'contact_call',$2,'{}',$3,'approved', now() + interval '1 hour', now()) RETURNING id`,
    [ownerId, contactId, HASH],
  );
  const req = await db.query<{ id: string }>(
    `INSERT INTO call_requests (owner_id, contact_id, plan, plan_hash, authorization_id, status) VALUES ($1,$2,'{}',$3,$4,'queued') RETURNING id`,
    [ownerId, contactId, HASH, auth.rows[0]!.id],
  );
  return { authorizationId: auth.rows[0]!.id, callRequestId: req.rows[0]!.id };
}
