import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Clock } from '../../application/clock.js';
import { enqueueJob } from '../jobs/jobs.js';
import type { AuthorizationService } from './authorizations.service.js';
import { encodeLimit, extractPriceLimits, type PriceLimit } from './negotiation.js';

/** Things the AI may never do on a contact call, whatever the contact asks. Part of the plan the owner approved. */
export const DEFAULT_FORBIDDEN_COMMITMENTS = [
  "egasi topshirig'ida ko'rsatilgan narx/shart chegarasidan tashqarida kelishmaslik va qaror qilmaslik (chegara ichidagi narxni esa o'zing qabul qila olasan)",
  'shartnoma yoki majburiyat tuzmaslik',
  "egasi nomidan qaror qabul qilmaslik yoki yangi va'da bermaslik",
  "egasining boshqa shaxsiy ma'lumotlarini, vazifalari yoki kontaktlarini aytmaslik",
] as const;

/** Explicit limits win; a text-derived limit is added only for a kind/currency not already set. */
function mergeLimits(explicit: PriceLimit[], fromText: PriceLimit[]): PriceLimit[] {
  const seen = new Set(explicit.map((l) => `${l.kind}:${l.currency}`));
  return [...explicit, ...fromText.filter((l) => !seen.has(`${l.kind}:${l.currency}`))];
}

export const CONTACT_CALL_MAX_SECONDS = 300;
/** Entries of a plan's `allowedContext` that carry the owner-approved meeting times (UTC ISO instants). */
export const MEETING_SLOT_PREFIX = 'slot:';
const PLAN_VALID_AFTER_DUE_MS = 30 * 60_000;

export type RequestContactCallResult =
  { ok: true; callRequestId: string; dueAt: Date } | { ok: false; reason: 'no_permission' | 'permission_expired' | 'not_found' | 'empty_message' };

/**
 * Creates a call request to a vouched contact on the OWNER's explicit command (chat message or owner call). The request is approved
 * by that command, sealed like every plan, and queued for its due time; whether it may actually dial is decided later by the dial policy.
 */
export class ContactCallService {
  constructor(
    private readonly authorizations: AuthorizationService,
    private readonly clock: Clock,
  ) {}

  async request(
    c: pg.PoolClient,
    ownerId: string,
    a: {
      contactId: string;
      message: string;
      dueAt?: Date | undefined;
      language: 'uz' | 'en' | 'ru';
      /** Meeting times the owner offers (the AI may confirm only one of these). */ slots?: Date[];
      /** Price limits stated as structured values (e.g. by the owner-call tool); merged with those read from the text. */ limits?: PriceLimit[];
    },
  ): Promise<RequestContactCallResult> {
    const message = a.message.trim().slice(0, 2000);
    if (message.length < 3) return { ok: false, reason: 'empty_message' };
    const now = this.clock.now();
    const contact = await c.query<{ telegram_user_id: string }>('SELECT telegram_user_id FROM contacts WHERE id=$1 AND owner_id=$2', [a.contactId, ownerId]);
    if (!contact.rows[0]) return { ok: false, reason: 'not_found' };
    const perm = await c.query<{ allow_call: boolean; expires_at: Date; revoked_at: Date | null; topic_scopes: string[] }>(
      'SELECT allow_call, expires_at, revoked_at, topic_scopes FROM contact_permissions WHERE contact_id=$1 AND owner_id=$2 ORDER BY version DESC LIMIT 1',
      [a.contactId, ownerId],
    );
    const p = perm.rows[0];
    if (!p || !p.allow_call || p.revoked_at || !p.topic_scopes.includes('general')) return { ok: false, reason: 'no_permission' };
    if (p.expires_at.getTime() <= now.getTime()) return { ok: false, reason: 'permission_expired' };

    const dueAt = a.dueAt && a.dueAt.getTime() > now.getTime() ? a.dueAt : now;
    const r = await this.authorizations.createCallRequest(
      ownerId,
      {
        callRequestId: randomUUID(),
        ownerId,
        recipientTelegramId: contact.rows[0].telegram_user_id,
        topic: 'general',
        purpose: message,
        questions: [],
        allowedContext: [
          message,
          // The owner's price limits are read from his own words here, in code, and enforced during the call.
          ...mergeLimits(a.limits ?? [], extractPriceLimits(message)).map(encodeLimit),
          ...(a.slots ?? [])
            .filter((d) => d.getTime() > now.getTime())
            .slice(0, 5)
            .map((d) => `${MEETING_SLOT_PREFIX}${d.toISOString()}`),
        ],
        forbiddenCommitments: [...DEFAULT_FORBIDDEN_COMMITMENTS],
        language: a.language,
        maxDurationSeconds: CONTACT_CALL_MAX_SECONDS,
        expiresAt: new Date(dueAt.getTime() + PLAN_VALID_AFTER_DUE_MS).toISOString(),
      },
      { ownerExplicitCommand: true },
      c,
    );
    await enqueueJob(c, {
      ownerId,
      kind: 'call.dial',
      dueAt,
      dedupeKey: `dial:${r.callRequestId}`,
      payload: { callRequestId: r.callRequestId },
      maxAttempts: 1,
    });
    return { ok: true, callRequestId: r.callRequestId, dueAt };
  }
}
