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

  /**
   * Add (or re-activate) a contact the OWNER vouches for: numeric id confirmed by the owner, the owner's attestation that the contact
   * was told about AI calls in advance (recorded as the OWNER's statement), and a default permission for general business calls
   * (9:00-20:00, 90 days). One transaction; an existing contact is updated, not duplicated.
   */
  async addVouched(db: Queryable, ownerId: string, i: { telegramUserId: string; displayName: string }, now: Date): Promise<{ id: string; created: boolean }> {
    if (!i.displayName.trim() || i.displayName.trim().length > 80) throw new ValidationError('contact name must be 1-80 characters');
    return inTx(db, async (q) => {
      const existed = await q.query('SELECT 1 FROM contacts WHERE owner_id=$1 AND telegram_user_id=$2', [ownerId, i.telegramUserId]);
      const { id } = await this.create(
        q,
        ownerId,
        { telegramUserId: i.telegramUserId, displayName: i.displayName, verificationSource: 'owner_confirmed_numeric_id' },
        now,
      );
      await q.query('UPDATE contacts SET ai_consent_attested_at=$3, ai_consent_revoked_at=NULL WHERE id=$1 AND owner_id=$2', [id, ownerId, now]);
      await writeAudit(q, {
        ownerId,
        actorType: 'owner',
        action: 'contact.ai_consent_attested',
        resourceType: 'contact',
        resourceId: id,
        allowed: true,
        reasonCode: 'ok',
      });
      await this.grantLocked(
        q,
        ownerId,
        id,
        { allowCall: true, topicScopes: ['general'], allowedHours: { start: '09:00', end: '20:00' }, expiresAt: new Date(now.getTime() + 90 * 24 * 3600_000) },
        now,
      );
      return { id, created: !existed.rowCount };
    });
  }

  /** Changes the hours this contact may be called in (new permission version; everything else is copied). `null` = any time. Refused for a withdrawn contact. */
  async setCallHours(db: Queryable, ownerId: string, contactId: string, hours: { start: string; end: string } | null, now: Date): Promise<{ ok: boolean }> {
    return inTx(db, async (q) => {
      const locked = await q.query('SELECT 1 FROM contacts WHERE id=$1 AND owner_id=$2 FOR UPDATE', [contactId, ownerId]);
      if (!locked.rowCount) throw new NotFoundError('contact');
      const cur = await q.query<{
        version: number;
        allow_call: boolean;
        allow_message: boolean;
        topic_scopes: string[];
        context_allowlist: string[];
        expires_at: Date;
        revoked_at: Date | null;
      }>(
        'SELECT version, allow_call, allow_message, topic_scopes, context_allowlist, expires_at, revoked_at FROM contact_permissions WHERE contact_id=$1 AND owner_id=$2 ORDER BY version DESC LIMIT 1',
        [contactId, ownerId],
      );
      const p = cur.rows[0];
      if (!p || !p.allow_call || p.revoked_at) return { ok: false };
      await q.query(
        `INSERT INTO contact_permissions (owner_id, contact_id, version, allow_call, allow_message, topic_scopes, context_allowlist, allowed_hours, expires_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          ownerId,
          contactId,
          p.version + 1,
          p.allow_call,
          p.allow_message,
          p.topic_scopes,
          p.context_allowlist,
          hours ? JSON.stringify(hours) : null,
          p.expires_at,
          now,
        ],
      );
      await writeAudit(q, {
        ownerId,
        actorType: 'owner',
        action: 'permission.call_hours',
        resourceType: 'contact',
        resourceId: contactId,
        allowed: true,
        reasonCode: 'ok',
      });
      return { ok: true };
    });
  }

  /** The owner withdraws the contact: the attestation is revoked and calling permission ends. Queued calls are cancelled by the caller. */
  async removeVouched(db: Queryable, ownerId: string, contactId: string, now: Date): Promise<void> {
    await inTx(db, async (q) => {
      const r = await q.query('UPDATE contacts SET ai_consent_revoked_at=$3 WHERE id=$1 AND owner_id=$2 RETURNING id', [contactId, ownerId, now]);
      if (!r.rowCount) throw new NotFoundError('contact');
      await writeAudit(q, {
        ownerId,
        actorType: 'owner',
        action: 'contact.ai_consent_revoked',
        resourceType: 'contact',
        resourceId: contactId,
        allowed: true,
        reasonCode: 'ok',
      });
      const hasPermission = await q.query('SELECT 1 FROM contact_permissions WHERE contact_id=$1 AND owner_id=$2 LIMIT 1', [contactId, ownerId]);
      if (hasPermission.rowCount) await this.revokeLocked(q, ownerId, contactId, now);
    });
  }

  async list(q: Queryable, ownerId: string): Promise<Array<{ id: string; displayName: string; telegramUserId: string; active: boolean }>> {
    const r = await q.query<{ id: string; display_name: string; telegram_user_id: string; active: boolean }>(
      `SELECT c.id, c.display_name, c.telegram_user_id,
              (c.verified_at IS NOT NULL AND c.ai_consent_attested_at IS NOT NULL
                AND (c.ai_consent_revoked_at IS NULL OR c.ai_consent_revoked_at < c.ai_consent_attested_at)) AS active
       FROM contacts c WHERE c.owner_id=$1 ORDER BY lower(c.display_name)`,
      [ownerId],
    );
    return r.rows.map((x) => ({ id: x.id, displayName: x.display_name, telegramUserId: x.telegram_user_id, active: x.active }));
  }

  /**
   * Resolve a spoken or typed name to ONE contact, or say why not. Never guesses: ambiguous or unknown names return no contact.
   * Case, apostrophes and Uzbek case suffixes written after the name ("Javlonga") are tolerated by trying the name with and without them.
   */
  async resolveByName(
    q: Queryable,
    ownerId: string,
    spoken: string,
  ): Promise<{ kind: 'one'; contact: { id: string; displayName: string; telegramUserId: string } } | { kind: 'none' } | { kind: 'many'; names: string[] }> {
    const norm = (x: string) =>
      x
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f'‘’ʻʼ`´]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    const all = (await this.list(q, ownerId)).filter((c) => c.active);
    const forms = new Set<string>();
    const base = norm(spoken);
    forms.add(base);
    for (const suffix of ['ga', 'ka', 'qa', 'ni', 'dan', 'ning', 'bilan'])
      if (base.endsWith(suffix) && base.length > suffix.length + 1) forms.add(base.slice(0, -suffix.length));
    const pick = (test: (name: string, form: string) => boolean) => {
      const hits = all.filter((c) => [...forms].some((f) => test(norm(c.displayName), f)));
      return hits;
    };
    for (const test of [(n: string, f: string) => n === f, (n: string, f: string) => n.startsWith(f), (n: string, f: string) => n.includes(f)]) {
      const hits = pick(test);
      if (hits.length === 1) return { kind: 'one', contact: hits[0]! };
      if (hits.length > 1) return { kind: 'many', names: hits.map((h) => h.displayName) };
    }
    return { kind: 'none' };
  }
}
