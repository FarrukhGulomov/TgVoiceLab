import { DateTime } from 'luxon';
import type { Db } from '../../infrastructure/db/db.js';
import type { DataCrypto } from '../../infrastructure/crypto/data-crypto.js';
import type { MessagingPort } from '../../application/ports.js';
import type { OutboxHandler } from '../outbox/outbox.js';
import { t, type Locale, type MessageKey } from './i18n.js';
import type { Recurrence } from '../scheduling/recurrence.js';

interface OwnerRow { telegram_user_id: string; locale: Locale; timezone: string }
interface ReminderRow { title_enc: string; timezone: string; recurrence: Recurrence | null; next_occurrence_at: Date | null; local: string }

const recurrenceText = (loc: Locale, rec: Recurrence | null): string => {
  if (!rec) return '';
  const key = `recurrence_${rec.freq}` as MessageKey;
  return t(loc, key, { n: rec.interval });
};

const REASONS: Record<string, string> = {
  kill_switch_on: 'calling is switched off', calling_not_verified: 'real calling is not verified on this deployment',
  consent_mechanism_unproven: 'the consent mechanism for third-party calls is not proven', permission_revoked: 'permission was revoked',
  permission_expired: 'permission expired', permission_version_stale: 'permissions changed after you approved the plan',
  plan_hash_mismatch: 'the plan changed after approval', authorization_expired: 'the approval expired', authorization_not_approved: 'there is no valid approval',
  active_call_exists: 'another call is in progress', budget_not_reserved: 'the daily budget is exhausted', quiet_hours: 'quiet hours',
  outside_allowed_hours: 'outside the hours this contact allows', topic_not_permitted: 'topic not permitted for this contact',
  declined: 'declined', busy: 'busy', no_answer: 'no answer', privacy_restricted: 'the contact’s privacy settings do not allow calls',
  transport_error: 'connection problem', cancelled: 'cancelled', duration_limit: 'time limit reached', outcome_unknown: 'outcome unknown',
};

/** Outbox -> Telegram. Idempotent on the outbox event id (used as the provider dedupe key). */
export function makeOutboxHandlers(deps: { db: Db; crypto: DataCrypto; messaging: MessagingPort }): Record<string, OutboxHandler> {
  const { db, crypto, messaging } = deps;

  const loadOwner = async (ownerId: string): Promise<OwnerRow> =>
    (await db.query<OwnerRow>('SELECT telegram_user_id, locale, timezone FROM owners WHERE id=$1', [ownerId])).rows[0]!;
  const loadReminder = async (ownerId: string, id: string): Promise<ReminderRow & { title: string }> => {
    const r = (await db.query<ReminderRow>(
      `SELECT title_enc, timezone, recurrence, next_occurrence_at, to_char(local_wall_clock,'YYYY-MM-DD"T"HH24:MI') AS local FROM reminders WHERE id=$1 AND owner_id=$2`,
      [id, ownerId],
    )).rows[0]!;
    return { ...r, title: crypto.dec(ownerId, 'reminders.title', r.title_enc) };
  };

  return {
    'owner.notice': async (row) => {
      const p = row.payload as { template: 'reminder_scheduled' | 'reminder_rescheduled' | 'reminder_cancelled'; reminderId: string; scheduledAt?: string; timezone?: string; dstGap?: boolean };
      const owner = await loadOwner(row.ownerId);
      const rem = await loadReminder(row.ownerId, p.reminderId);
      let text: string;
      if (p.template === 'reminder_cancelled') text = t(owner.locale, 'reminder_cancelled', { title: rem.title });
      else {
        // Render the instant captured when the notice was created, not the reminder's current (mutable) next occurrence:
        // the notice may be delivered long after the fact (outage), when the reminder has already fired or moved.
        const at = DateTime.fromISO(p.scheduledAt!, { zone: p.timezone ?? rem.timezone });
        const time = at.toFormat('HH:mm');
        text = t(owner.locale, p.template, {
          title: rem.title, date: at.toFormat('yyyy-LL-dd'), time, tz: p.timezone ?? rem.timezone,
          recurrence: recurrenceText(owner.locale, rem.recurrence), dst: p.dstGap ? t(owner.locale, 'dst_gap', { time }) : '',
        });
      }
      await messaging.sendMessage({ toTelegramUserId: owner.telegram_user_id, text, idempotencyKey: row.eventId });
    },

    'reminder.notify': async (row) => {
      const p = row.payload as { reminderId: string; variant: string; silent: boolean; scheduledAt: string };
      const owner = await loadOwner(row.ownerId);
      const rem = await loadReminder(row.ownerId, p.reminderId);
      const sched = DateTime.fromISO(p.scheduledAt, { zone: owner.timezone });
      const key = ({ normal: 'reminder_fire', late: 'reminder_fire_late', degraded_call: 'reminder_degraded_call', call_missed: 'reminder_call_missed', missed_summary: 'reminder_missed_summary' } as Record<string, MessageKey>)[p.variant] ?? 'reminder_fire';
      const text = t(owner.locale, key, { title: rem.title, date: sched.toFormat('yyyy-LL-dd'), time: sched.toFormat('HH:mm') });
      await messaging.sendMessage({ toTelegramUserId: owner.telegram_user_id, text, silent: p.silent, idempotencyKey: row.eventId });
    },

    'call.notify': async (row) => {
      const p = row.payload as { variant: 'rejected' | 'ended' | 'outcome_unknown'; reason?: string };
      const owner = await loadOwner(row.ownerId);
      const q = row.aggregateType === 'call'
        ? 'SELECT c.display_name FROM calls k JOIN call_requests r ON r.id=k.call_request_id JOIN contacts c ON c.id=r.contact_id WHERE k.id=$1 AND k.owner_id=$2'
        : 'SELECT c.display_name FROM call_requests r JOIN contacts c ON c.id=r.contact_id WHERE r.id=$1 AND r.owner_id=$2';
      const name = (await db.query<{ display_name: string }>(q, [row.aggregateId, row.ownerId])).rows[0]?.display_name ?? '?';
      const reason = REASONS[p.reason ?? ''] ?? p.reason ?? '';
      const key: MessageKey = p.variant === 'rejected' ? 'call_rejected' : p.variant === 'outcome_unknown' ? 'call_outcome_unknown' : 'call_ended';
      await messaging.sendMessage({ toTelegramUserId: owner.telegram_user_id, text: t(owner.locale, key, { name, reason }), idempotencyKey: row.eventId });
    },

    // Direct replies to owner messages (chat intake) travel through the outbox too, so they survive a crash after commit.
    'owner.reply': async (row) => {
      const p = row.payload as { textEnc: string };
      const owner = await loadOwner(row.ownerId);
      await messaging.sendMessage({ toTelegramUserId: owner.telegram_user_id, text: crypto.dec(row.ownerId, 'outbox.reply', p.textEnc), idempotencyKey: row.eventId });
    },
  };
}
