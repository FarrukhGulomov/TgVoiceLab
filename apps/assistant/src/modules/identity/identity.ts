import { TelegramUserIdSchema } from '@tgvl/contracts';
import type { Db, Queryable } from '../../infrastructure/db/db.js';
import { writeAudit } from '../audit/audit.js';
import { ValidationError } from '../../application/errors.js';

export interface Principal {
  ownerId: string;
  telegramUserId: string;
  locale: 'uz' | 'en' | 'ru';
  timezone: string;
}

export const bootstrapPhrase = (ownerId: string, assistantId: string) => `I CONFIRM OWNER=${ownerId} ASSISTANT=${assistantId}`;

/**
 * Local owner bootstrap. The first incoming sender is NEVER enrolled: the operator supplies both numeric IDs out of band
 * and must retype a confirmation that echoes them. Single-owner MVP: re-running with the same IDs is a no-op, different IDs fail.
 */
export async function bootstrapOwner(
  db: Db,
  i: { ownerTelegramId: string; assistantTelegramId: string; sessionSecretRef: string; timezone: string; locale?: 'uz' | 'en' | 'ru'; confirmation: string },
): Promise<{ ownerId: string; accountId: string; created: boolean }> {
  const owner = TelegramUserIdSchema.safeParse(i.ownerTelegramId);
  const asst = TelegramUserIdSchema.safeParse(i.assistantTelegramId);
  if (!owner.success || !asst.success) throw new ValidationError('owner and assistant must be numeric Telegram user ids (not usernames)');
  if (i.ownerTelegramId === i.assistantTelegramId) throw new ValidationError('the assistant account must be a different account from the owner');
  if (i.confirmation.trim() !== bootstrapPhrase(i.ownerTelegramId, i.assistantTelegramId)) throw new ValidationError('confirmation phrase does not match');
  if (!/^(file:|env:)/.test(i.sessionSecretRef)) throw new ValidationError('session secret must be a file: or env: reference');

  return db.tx(async (c) => {
    const existing = await c.query<{ id: string; telegram_user_id: string }>('SELECT id, telegram_user_id FROM owners LIMIT 2');
    if (existing.rows.length && !existing.rows.some((r) => r.telegram_user_id === i.ownerTelegramId))
      throw new ValidationError('an owner already exists; this MVP supports exactly one owner');
    const found = existing.rows.find((r) => r.telegram_user_id === i.ownerTelegramId);
    if (found) {
      const acc = await c.query<{ id: string }>('SELECT id FROM telegram_accounts WHERE owner_id=$1 AND assistant_telegram_user_id=$2', [
        found.id,
        i.assistantTelegramId,
      ]);
      if (!acc.rows[0]) throw new ValidationError('owner exists with a different assistant account');
      return { ownerId: found.id, accountId: acc.rows[0].id, created: false };
    }
    const o = await c.query<{ id: string }>('INSERT INTO owners (telegram_user_id, timezone, locale) VALUES ($1,$2,$3) RETURNING id', [
      i.ownerTelegramId,
      i.timezone,
      i.locale ?? 'uz',
    ]);
    const ownerId = o.rows[0]!.id;
    const a = await c.query<{ id: string }>(
      `INSERT INTO telegram_accounts (owner_id, assistant_telegram_user_id, session_secret_ref, status) VALUES ($1,$2,$3,'unprovisioned') RETURNING id`,
      [ownerId, i.assistantTelegramId, i.sessionSecretRef],
    );
    await c.query('INSERT INTO operation_settings (owner_id) VALUES ($1)', [ownerId]); // calling kill switch defaults ON
    await writeAudit(c, {
      ownerId,
      actorType: 'system',
      action: 'identity.bootstrap',
      resourceType: 'owner',
      resourceId: ownerId,
      allowed: true,
      reasonCode: 'ok',
    });
    return { ownerId, accountId: a.rows[0]!.id, created: true };
  });
}

export type AuthResult =
  { ok: true; principal: Principal } | { ok: false; reason: 'unknown_sender' | 'not_private_chat' | 'owner_disabled' | 'account_mismatch' };

/** Owner commands are accepted only from the owner's numeric id, in a private chat, on the owner's own assistant account. */
export async function authenticateOwnerMessage(
  db: Queryable,
  i: { accountId: string; senderTelegramId: string; chat: { type: string; id: string } },
  now: Date,
): Promise<AuthResult> {
  const r = await db.query<{ id: string; telegram_user_id: string; locale: Principal['locale']; timezone: string; disabled: boolean; account_owner: string }>(
    `SELECT o.id, o.telegram_user_id, o.locale, o.timezone, o.disabled, a.owner_id AS account_owner
     FROM owners o JOIN telegram_accounts a ON a.id = $2 WHERE o.telegram_user_id = $1`,
    [i.senderTelegramId, i.accountId],
  );
  const row = r.rows[0];
  const deny = async (reason: Exclude<AuthResult, { ok: true }>['reason'], ownerId?: string): Promise<AuthResult> => {
    // At most one audit row per (sender, reason) per minute: a spammer must not be able to grow the audit table unboundedly.
    await db.query(
      `INSERT INTO audit_events (owner_id, actor_type, actor_id, action, allowed, reason_code)
       SELECT $1, 'unknown', $2, 'owner_command', false, $3
       WHERE NOT EXISTS (SELECT 1 FROM audit_events WHERE actor_type='unknown' AND actor_id=$2 AND reason_code=$3 AND created_at > $4::timestamptz - interval '60 seconds')`,
      [ownerId ?? null, i.senderTelegramId, reason, now],
    );
    return { ok: false, reason };
  };
  if (!row) return deny('unknown_sender');
  if (row.account_owner !== row.id) return deny('account_mismatch', row.id);
  if (row.disabled) return deny('owner_disabled', row.id);
  if (i.chat.type !== 'private' || i.chat.id !== i.senderTelegramId) return deny('not_private_chat', row.id);
  return { ok: true, principal: { ownerId: row.id, telegramUserId: row.telegram_user_id, locale: row.locale, timezone: row.timezone } };
}
