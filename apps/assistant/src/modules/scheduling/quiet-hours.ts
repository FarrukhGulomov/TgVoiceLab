import { DateTime } from 'luxon';

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
  const dt = DateTime.fromJSDate(at, { zone: tz });
  const cur = dt.hour * 60 + dt.minute;
  const s = mins(q.start);
  const e = mins(q.end);
  if (s === e) return false;
  return s < e ? cur >= s && cur < e : cur >= s || cur < e;
}
