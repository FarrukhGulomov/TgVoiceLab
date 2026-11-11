import { DateTime } from 'luxon';
import { resolveWallClock, toLocalString, type ResolvedInstant } from './wallclock.js';

export interface Recurrence {
  freq: 'daily' | 'weekly' | 'monthly';
  interval: number;
  /** ISO weekdays 1 (Mon) .. 7 (Sun); weekly only. Defaults to the anchor's weekday. */
  byWeekday?: number[] | undefined;
}

/**
 * Next occurrence strictly after `after`, computed in the LOCAL wall-clock domain so "every day at 09:00" stays
 * 09:00 across DST changes, then resolved to UTC per occurrence (so each occurrence gets the zone's rules for that date).
 * `anchorLocal` is the reminder's original local wall clock ("YYYY-MM-DDTHH:mm"). Monthly days clamp to month end.
 */
export function nextOccurrence(anchorLocal: string, tz: string, rec: Recurrence, after: Date): ResolvedInstant {
  const anchor = DateTime.fromISO(anchorLocal, { zone: 'utc' });
  const time = { hour: anchor.hour, minute: anchor.minute };
  const afterLocal = DateTime.fromJSDate(after, { zone: tz });
  const startDay = DateTime.fromObject({ year: afterLocal.year, month: afterLocal.month, day: afterLocal.day }, { zone: 'utc' });
  const anchorDay = DateTime.fromObject({ year: anchor.year, month: anchor.month, day: anchor.day }, { zone: 'utc' });
  const weekdays = rec.byWeekday?.length ? [...rec.byWeekday].sort() : [anchor.weekday];

  const matches = (day: DateTime): boolean => {
    if (day < anchorDay) return false;
    switch (rec.freq) {
      case 'daily':
        return Math.round(day.diff(anchorDay, 'days').days) % rec.interval === 0;
      case 'weekly': {
        // Weeks are counted from the Monday of the anchor's week, so `interval: 2` means every other calendar week.
        const anchorWeekStart = anchorDay.minus({ days: anchorDay.weekday - 1 });
        const w = Math.floor(day.diff(anchorWeekStart, 'days').days / 7);
        return w % rec.interval === 0 && weekdays.includes(day.weekday);
      }
      case 'monthly': {
        const months = (day.year - anchor.year) * 12 + (day.month - anchor.month);
        if (months < 0 || months % rec.interval !== 0) return false;
        const target = Math.min(anchor.day, day.endOf('month').day);
        return day.day === target;
      }
    }
  };

  for (let i = 0; i < 366 * 12; i++) {
    const day = startDay.plus({ days: i });
    if (!matches(day)) continue;
    const local = day.set(time).toFormat("yyyy-LL-dd'T'HH:mm");
    const r = resolveWallClock(local, tz);
    if (r.utc.getTime() > after.getTime()) return r;
  }
  throw new Error('no next occurrence within 12 years');
}

export { toLocalString };
