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

    // Direct replies to owner messages (chat intake) travel through the outbox too, so they survive a crash after commit.
    'owner.reply': async (row) => {
      const p = row.payload as { textEnc: string };
      const owner = await loadOwner(row.ownerId);
      await messaging.sendMessage({ toTelegramUserId: owner.telegram_user_id, text: crypto.dec(row.ownerId, 'outbox.reply', p.textEnc), idempotencyKey: row.eventId });
    },
  };
}
