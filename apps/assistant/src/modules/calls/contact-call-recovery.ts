import type { Db } from '../../infrastructure/db/db.js';
import type { DataCrypto } from '../../infrastructure/crypto/data-crypto.js';
import type { Clock } from '../../application/clock.js';
import type { MessageComposerPort } from '../../application/ports.js';
import { emitOutbox } from '../outbox/outbox.js';
import { writeAudit } from '../audit/audit.js';
import { openPlan } from './plan-store.js';
import { MEETING_SLOT_PREFIX, type ContactCallService } from './contact-calls.service.js';
import { t, type Locale } from '../messaging/i18n.js';

/** Total tries (the first call plus two redials) before the message goes out as text. */
export const MAX_CALL_ATTEMPTS = 3;
/** Pause before a redial, so the other side's phone has stopped ringing. */
export const REDIAL_DELAY_MS = 45_000;

/**
 * Standing owner instruction: when a contact picks up but the audio never connects (`transport_error`), redial automatically up to
 * 3 attempts in total; if it still does not connect, send the contact the message as text instead. Only that failure is retried:
 * no answer, busy, declined and privacy-restricted calls are never redialled.
 */
export class ContactCallRecovery {
  constructor(
    private readonly d: {
      db: Db;
      crypto: DataCrypto;
      clock: Clock;
      contactCalls: ContactCallService;
      composer?: MessageComposerPort | undefined;
    },
  ) {}

  /** Returns a short note for the owner (what happens next), or null when nothing applies. Safe to call twice for the same call. */
  async onEnded(ownerId: string, callId: string, reason: string): Promise<string | null> {
    if (reason !== 'transport_error') return null;
    const { db, crypto, clock } = this.d;
    const row = (
      await db.query<{
        id: string;
        contact_id: string;
        attempt: number;
        plan: unknown;
        plan_enc: string | null;
        display_name: string;
        locale: Locale;
        owner_name: string | null;
        active: boolean;
      }>(
        `SELECT r.id, r.contact_id, r.attempt, r.plan, r.plan_enc, c.display_name, o.locale, o.display_name AS owner_name,
                (c.verified_at IS NOT NULL AND c.ai_consent_attested_at IS NOT NULL
                  AND (c.ai_consent_revoked_at IS NULL OR c.ai_consent_revoked_at < c.ai_consent_attested_at)) AS active
           FROM calls k JOIN call_requests r ON r.id=k.call_request_id JOIN contacts c ON c.id=r.contact_id JOIN owners o ON o.id=r.owner_id
          WHERE k.id=$1 AND k.owner_id=$2`,
        [callId, ownerId],
      )
    ).rows[0];
    if (!row || !row.active) return null;
    const plan = openPlan(crypto, ownerId, row.plan, row.plan_enc);
    const loc = row.locale;

    if (row.attempt < MAX_CALL_ATTEMPTS) {
      return db.tx(async (c) => {
        const done = await c.query('SELECT 1 FROM call_requests WHERE retry_of=$1 AND owner_id=$2', [row.id, ownerId]);
        if (done.rowCount) return null; // this failure was already handled
        const slots = plan.allowedContext
          .filter((x) => x.startsWith(MEETING_SLOT_PREFIX))
          .map((x) => new Date(x.slice(MEETING_SLOT_PREFIX.length)))
          .filter((x) => Number.isFinite(x.getTime()));
        const res = await this.d.contactCalls.request(c, ownerId, {
          contactId: row.contact_id,
          message: plan.purpose,
          dueAt: new Date(clock.now().getTime() + REDIAL_DELAY_MS),
          language: plan.language,
          ...(slots.length ? { slots } : {}),
        });
        if (!res.ok) return null;
        await c.query('UPDATE call_requests SET attempt=$3, retry_of=$4 WHERE id=$1 AND owner_id=$2', [res.callRequestId, ownerId, row.attempt + 1, row.id]);
        return t(loc, 'call_retry', { name: row.display_name, n: row.attempt + 1, max: MAX_CALL_ATTEMPTS });
      });
    }

    // Out of tries: the message goes out as text (a voice note would need speech synthesis, which is not built).
    const ownerName = row.owner_name ?? '';
    const composed = this.d.composer
      ? await this.d.composer.compose({ ownerName: ownerName || 'egasi', contactName: row.display_name, brief: plan.purpose }).catch(() => null)
      : null;
    if (!composed) return t(loc, 'call_retries_exhausted_no_text', { name: row.display_name, max: MAX_CALL_ATTEMPTS });
    const text = composed;
    return db.tx(async (c) => {
      const done = await c.query(`SELECT 1 FROM audit_events WHERE owner_id=$1 AND action='call.fallback_text' AND resource_id=$2`, [ownerId, row.id]);
      if (done.rowCount) return null;
      await writeAudit(c, {
        ownerId,
        actorType: 'system',
        action: 'call.fallback_text',
        resourceType: 'call_request',
        resourceId: row.id,
        allowed: true,
        reasonCode: 'ok',
      });
      await emitOutbox(
        c,
        {
          ownerId,
          aggregateType: 'contact',
          aggregateId: row.contact_id,
          type: 'contact.message',
          payload: { contactId: row.contact_id, textEnc: crypto.enc(ownerId, 'outbox.contact_message', text) },
        },
        clock.now(),
      );
      return t(loc, 'call_fallback_text', { name: row.display_name, max: MAX_CALL_ATTEMPTS, text: text.slice(0, 600) });
    });
  }
}
