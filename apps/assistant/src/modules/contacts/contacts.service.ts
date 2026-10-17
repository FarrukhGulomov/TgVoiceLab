import { TelegramUserIdSchema } from '@tgvl/contracts';
import { inTx, type Queryable } from '../../infrastructure/db/db.js';
import { NotFoundError, ValidationError } from '../../application/errors.js';
import { writeAudit } from '../audit/audit.js';
import type { DataCrypto } from '../../infrastructure/crypto/data-crypto.js';

/** AAD label for sealed free-text context entries (audit F10). */
export const CONTEXT_AAD_COLUMN = 'contact_permissions.context_allowlist';

export interface PermissionGrant {
  allowCall: boolean;
  allowMessage?: boolean | undefined;
  topicScopes: string[];
  contextAllowlist?: string[] | undefined;
  allowedHours?: { start: string; end: string } | null;
  expiresAt: Date;
}

/**
 * Contacts are identified by NUMERIC Telegram id; usernames/display names are lookup aids only. A contact is "verified"
 * only when the owner confirms the numeric id (e.g. by contact card / forwarded-from id) — recorded with its source.
 */
export class ContactService {
  constructor(private readonly crypto: DataCrypto) {}

  async create(
    q: Queryable,
    ownerId: string,
    i: { telegramUserId: string; displayName: string; verificationSource: 'owner_confirmed_numeric_id' | 'contact_card'; timezone?: string | undefined },
    now: Date,
  ) {
    if (!TelegramUserIdSchema.safeParse(i.telegramUserId).success) throw new ValidationError('contact must be identified by a numeric Telegram id');
    const r = await q.query<{ id: string }>(
      `INSERT INTO contacts (owner_id, telegram_user_id, display_name, verified_at, verification_source, timezone) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (owner_id, telegram_user_id) DO UPDATE SET display_name = EXCLUDED.display_name RETURNING id`,
      [ownerId, i.telegramUserId, i.displayName.trim(), now, i.verificationSource, i.timezone ?? null],
    );
    await writeAudit(q, {
      ownerId,
      actorType: 'owner',
      action: 'contact.create',
      resourceType: 'contact',
      resourceId: r.rows[0]!.id,
      allowed: true,
      reasonCode: 'ok',
    });
    return { id: r.rows[0]!.id };
  }

  /** Grants are versioned and immutable: a change inserts version N+1 (history is the audit trail). */
  async grant(db: Queryable, ownerId: string, contactId: string, g: PermissionGrant, now: Date): Promise<{ version: number }> {
    if (g.expiresAt.getTime() <= now.getTime()) throw new ValidationError('permission must expire in the future');
    if (!g.topicScopes.length) throw new ValidationError('at least one topic scope is required');
    // Grant and revoke take the SAME row lock (contacts row) before allocating a version, so concurrent changes serialize: the
    // later committer always gets the next version and the latest committed version decides (audit F20).
    return inTx(db, (q) => this.grantLocked(q, ownerId, contactId, g, now));
  }

  private async grantLocked(q: Queryable, ownerId: string, contactId: string, g: PermissionGrant, now: Date): Promise<{ version: number }> {
    const c = await q.query('SELECT 1 FROM contacts WHERE id=$1 AND owner_id=$2 FOR UPDATE', [contactId, ownerId]);
    if (!c.rowCount) throw new NotFoundError('contact');
    const v = await q.query<{ v: number }>('SELECT coalesce(max(version),0)+1 AS v FROM contact_permissions WHERE contact_id=$1', [contactId]);
    const version = v.rows[0]!.v;
    await q.query(
      `INSERT INTO contact_permissions (owner_id, contact_id, version, allow_call, allow_message, topic_scopes, context_allowlist, allowed_hours, expires_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        ownerId,
        contactId,
        version,
        g.allowCall,
        g.allowMessage ?? false,
        g.topicScopes,
        (g.contextAllowlist ?? []).map((e) => this.crypto.enc(ownerId, CONTEXT_AAD_COLUMN, e)), // free text is stored sealed, one entry per element
        g.allowedHours ? JSON.stringify(g.allowedHours) : null,
        g.expiresAt,
        now,
      ],
    );
    await writeAudit(q, {
      ownerId,
      actorType: 'owner',
      action: 'permission.grant',
      resourceType: 'contact',
      resourceId: contactId,
      allowed: true,
      reasonCode: 'ok',
      metadata: { version },
    });
    return { version };
  }

  /** Revocation is a new version with revoked_at set (the latest version always decides). */
  async revoke(db: Queryable, ownerId: string, contactId: string, now: Date): Promise<{ version: number }> {
    return inTx(db, (q) => this.revokeLocked(q, ownerId, contactId, now));
  }

  private async revokeLocked(q: Queryable, ownerId: string, contactId: string, now: Date): Promise<{ version: number }> {
    const locked = await q.query('SELECT 1 FROM contacts WHERE id=$1 AND owner_id=$2 FOR UPDATE', [contactId, ownerId]);
    if (!locked.rowCount) throw new NotFoundError('contact');
    const cur = await q.query<{
      version: number;
      allow_message: boolean;
      topic_scopes: string[];
      context_allowlist: string[];
      allowed_hours: unknown;
      expires_at: Date;
    }>(
      'SELECT version, allow_message, topic_scopes, context_allowlist, allowed_hours, expires_at FROM contact_permissions WHERE contact_id=$1 AND owner_id=$2 ORDER BY version DESC LIMIT 1',
      [contactId, ownerId],
    );
    const p = cur.rows[0];
    if (!p) throw new NotFoundError('permission');
    const version = p.version + 1;
    await q.query(
      `INSERT INTO contact_permissions (owner_id, contact_id, version, allow_call, allow_message, topic_scopes, context_allowlist, allowed_hours, expires_at, revoked_at, created_at)
       VALUES ($1,$2,$3,false,false,$4,$5,$6,$7,$8,$8)`,
      [
        ownerId,
        contactId,
        version,
        p.topic_scopes,
        p.context_allowlist,
        p.allowed_hours ? JSON.stringify(p.allowed_hours) : null,
        new Date(Math.max(p.expires_at.getTime(), now.getTime() + 1000)),
        now,
      ],
    );
    await writeAudit(q, {
      ownerId,
      actorType: 'owner',
      action: 'permission.revoke',
      resourceType: 'contact',
      resourceId: contactId,
      allowed: true,
      reasonCode: 'ok',
      metadata: { version },
    });
    return { version };
  }
}
