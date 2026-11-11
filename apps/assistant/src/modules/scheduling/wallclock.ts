import { ValidationError } from '../../application/errors.js';
import { DateTime, FixedOffsetZone, IANAZone } from 'luxon';

export class InvalidTimezoneError extends ValidationError {
  constructor(tz: string) {
    super(`unknown IANA timezone: ${tz}`);
    this.name = 'InvalidTimezoneError';
  }
}

export function assertTimezone(tz: string): void {
  if (!IANAZone.isValidZone(tz)) throw new InvalidTimezoneError(tz);
}

export interface ResolvedInstant {
  utc: Date;
  /** How the wall-clock time mapped onto the timeline. */
  kind: 'exact' | 'gap_shifted_forward' | 'overlap_earlier';
}

const offsetAt = (utcMs: number, tz: string): number => DateTime.fromMillis(utcMs, { zone: tz }).offset; // minutes

const parts = (local: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) throw new Error(`bad local datetime: ${local}`);
  return { y: +m[1]!, mo: +m[2]!, d: +m[3]!, h: +m[4]!, mi: +m[5]! };
};

/**
 * Resolve a local wall-clock time (no offset) in an IANA zone to a UTC instant with the documented DST policy:
 *  - nonexistent local time (spring-forward gap) -> the first valid instant after the gap (e.g. 02:30 -> 03:00 local);
 *  - repeated local time (fall-back overlap)     -> the EARLIER of the two instants.
 */
export function resolveWallClock(local: string, tz: string): ResolvedInstant {
  assertTimezone(tz);
  const p = parts(local);
  const asUtcMs = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
  // Candidate offsets around the target (±1 day covers every real transition).
  const offs = new Set<number>([offsetAt(asUtcMs - 86_400_000, tz), offsetAt(asUtcMs + 86_400_000, tz)]);
  const valid: number[] = [];
  for (const off of offs) {
    const cand = asUtcMs - off * 60_000;
    const back = DateTime.fromMillis(cand, { zone: tz });
    if (back.year === p.y && back.month === p.mo && back.day === p.d && back.hour === p.h && back.minute === p.mi) valid.push(cand);
  }
  if (valid.length === 1) return { utc: new Date(valid[0]!), kind: 'exact' };
  if (valid.length >= 2) return { utc: new Date(Math.min(...valid)), kind: 'overlap_earlier' };
  // Gap: find the transition instant between the two candidate mappings by bisection on the UTC offset.
  const [a, b] = [...offs].map((o) => asUtcMs - o * 60_000).sort((x, y) => x - y) as [number, number];
  let lo = a;
  let hi = b;
  const offLo = offsetAt(lo, tz);
  while (hi - lo > 60_000) {
    const mid = Math.floor((lo + hi) / 2 / 60_000) * 60_000;
    if (offsetAt(mid, tz) === offLo) lo = mid;
    else hi = mid;
  }
  return { utc: new Date(hi), kind: 'gap_shifted_forward' };
}

export const toLocalString = (utc: Date, tz: string): string => DateTime.fromJSDate(utc, { zone: tz }).toFormat("yyyy-LL-dd'T'HH:mm");

/** Human confirmation text input: local date, time and zone for an instant. */
export function describeInstant(utc: Date, tz: string): { date: string; time: string; tz: string; offset: string } {
  const dt = DateTime.fromJSDate(utc, { zone: tz });
  return { date: dt.toFormat('yyyy-LL-dd'), time: dt.toFormat('HH:mm'), tz, offset: dt.toFormat('ZZ') };
}

export { DateTime, FixedOffsetZone };
