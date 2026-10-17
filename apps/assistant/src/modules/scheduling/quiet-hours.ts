import { DateTime } from 'luxon';
import { ValidationError } from '../../application/errors.js';
import { assertTimezone } from './wallclock.js';

export interface QuietHours {
  enabled: boolean;
  /** "HH:mm" local */
  start: string;
  end: string;
}

const mins = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** True when `at` falls inside the owner's quiet window in their timezone. Handles windows that cross midnight. */
export function inQuietHours(at: Date, tz: string, q: QuietHours): boolean {
  if (!q.enabled) return false;
  // Fail clearly on bad configuration instead of computing nonsense (audit F18).
  assertTimezone(tz);
  const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!HHMM.test(q.start) || !HHMM.test(q.end)) throw new ValidationError('invalid quiet hours: start and end must be HH:mm (00:00-23:59)');
  const dt = DateTime.fromJSDate(at, { zone: tz });
  const cur = dt.hour * 60 + dt.minute;
  const s = mins(q.start);
  const e = mins(q.end);
  if (s === e) return false;
  return s < e ? cur >= s && cur < e : cur >= s || cur < e;
}
