import { DateTime } from 'luxon';
import type { RecurrenceIntent } from '../../application/intent.js';

/**
 * Deterministic date/time phrase extraction for Uzbek (Latin) and English. It is the rules-adapter's engine and the
 * oracle for tests; richer language understanding belongs to an LLM adapter that must still return the same Intent shape.
 * Principle: never guess across a genuine ambiguity — surface it (`ambiguousHour`) so the caller asks a question.
 */
export interface ExtractCtx {
  receivedAt: Date;
  timezone: string;
}
export interface ParsedWhen {
  date?: string;
  time?: string;
  /** Bare hour 1..6 with no meridiem/period word: could be morning or afternoon. */
  ambiguousHour?: number;
  invalid?: boolean;
  recurrence?: RecurrenceIntent;
  /** Input with the matched scheduling phrases removed (original casing preserved). */
  rest: string;
}

const WEEKDAYS: Record<string, number> = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7,
  dushanba: 1,
  seshanba: 2,
  chorshanba: 3,
  payshanba: 4,
  juma: 5,
  shanba: 6,
  yakshanba: 7,
};
const WD = Object.keys(WEEKDAYS).join('|');
const NUM_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const NW = Object.keys(NUM_WORDS).join('|');

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
  yanvar: 1,
  fevral: 2,
  mart: 3,
  aprel: 4,
  iyun: 6,
  iyul: 7,
  avgust: 8,
  sentyabr: 9,
  sentabr: 9,
  oktyabr: 10,
  oktabr: 10,
  noyabr: 11,
  dekabr: 12,
};
const MONTH_RE = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join('|');

/** Day + month (+ optional year) to an ISO date; without a year, the next such date on or after today. Null when the date does not exist. */
function monthDate(now: DateTime, day: number, month: number, year?: number): string | null {
  const make = (y: number) => DateTime.fromObject({ year: y, month, day }, { zone: now.zone });
  const first = make(year ?? now.year);
  if (!first.isValid) return null;
  if (year === undefined && first < now.startOf('day')) {
    const next = make(now.year + 1);
    return next.isValid ? next.toFormat('yyyy-LL-dd') : null;
  }
  return first.toFormat('yyyy-LL-dd');
}

export const normalizeApostrophes = (s: string): string => s.replace(/[‘’ʻʼ`´]/g, "'");
const squash = (s: string) =>
  s
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();

/** Remove the first match of `re` from `text`, returning the captured groups. */
function take(text: string, re: RegExp): { text: string; m: RegExpExecArray | null } {
  const m = re.exec(text);
  if (!m) return { text, m: null };
  return { text: text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length), m };
}

export function extractWhen(input: string, ctx: ExtractCtx): ParsedWhen {
  let text = normalizeApostrophes(input);
  const now = DateTime.fromJSDate(ctx.receivedAt, { zone: ctx.timezone });
  const out: ParsedWhen = { rest: '' };
  let r: ReturnType<typeof take>;

  // ---- recurrence ---------------------------------------------------------------------------------------------
  let recurWeekday: number | undefined;
  if ((r = take(text, new RegExp(`\\b(?:every|har)\\s+(${WD})\\b`, 'i'))).m) {
    recurWeekday = WEEKDAYS[r.m![1]!.toLowerCase()]!;
    out.recurrence = { freq: 'weekly', interval: 1, byWeekday: [recurWeekday] };
    text = r.text;
  } else if ((r = take(text, /\bevery\s+(\d+)\s+(day|week|month)s?\b/i)).m) {
    const n = Math.max(1, Math.min(366, +r.m![1]!));
    out.recurrence = { freq: ({ day: 'daily', week: 'weekly', month: 'monthly' } as const)[r.m![2]!.toLowerCase() as 'day'], interval: n };
    text = r.text;
  } else if ((r = take(text, /\b(?:every\s+day|each\s+day|daily|har\s+kuni|kundalik)\b/i)).m) {
    out.recurrence = { freq: 'daily', interval: 1 };
    text = r.text;
  } else if ((r = take(text, /\b(?:every\s+week|weekly|har\s+hafta)\b/i)).m) {
    out.recurrence = { freq: 'weekly', interval: 1 };
    text = r.text;
  } else if ((r = take(text, /\b(?:every\s+month|monthly|har\s+oy)\b/i)).m) {
    out.recurrence = { freq: 'monthly', interval: 1 };
    text = r.text;
  }

  // ---- relative offsets: "in 2 hours", "30 daqiqadan keyin" ---------------------------------------------------
  const rel = take(text, /\b(?:in\s+)?(\d{1,4})\s*(minutes?|mins?|hours?|hrs?|h|daqiqadan|daqiqa|soatdan|soat)(?:\s+(?:keyin|so'ng|song|sung))?\b/i);
  const isRel = rel.m && (/\bin\s+\d/i.test(rel.m[0]) || /keyin|so'ng|song|sung/i.test(rel.m[0]));
  if (rel.m && isRel) {
    const n = +rel.m[1]!;
    const unit = rel.m[2]!.toLowerCase();
    const mins = /^(m|daqiqa)/.test(unit) ? n : n * 60;
    const at = now.plus({ minutes: mins });
    out.date = at.toFormat('yyyy-LL-dd');
    out.time = at.toFormat('HH:mm');
    out.rest = squash(rel.text);
    return out;
  }

  // ---- date ---------------------------------------------------------------------------------------------------
  let dateFound = false;
  if ((r = take(text, /\b(\d{4})-(\d{2})-(\d{2})\b/)).m) {
    out.date = `${r.m![1]}-${r.m![2]}-${r.m![3]}`;
    if (!DateTime.fromISO(out.date).isValid) out.invalid = true;
    text = r.text;
    dateFound = true;
  } else if ((r = take(text, /\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b/)).m) {
    // day.month.year or day/month/year (never month-first: the owner is in Uzbekistan). Handled before the time-of-day rules,
    // which would otherwise read "15.10" as 15:10.
    const iso = `${r.m![3]}-${r.m![2]!.padStart(2, '0')}-${r.m![1]!.padStart(2, '0')}`;
    out.date = iso;
    if (!DateTime.fromISO(iso).isValid) out.invalid = true;
    text = r.text;
    dateFound = true;
  } else if ((r = take(text, new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?[-\\s]+(${MONTH_RE})\\b(?:\\s+(\\d{4}))?`, 'i'))).m) {
    const d = monthDate(now, +r.m![1]!, MONTHS[r.m![2]!.toLowerCase()]!, r.m![3] ? +r.m![3] : undefined);
    if (d) out.date = d;
    else out.invalid = true;
    text = r.text;
    dateFound = true;
  } else if ((r = take(text, new RegExp(`\\b(${MONTH_RE})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, 'i'))).m) {
    const d = monthDate(now, +r.m![2]!, MONTHS[r.m![1]!.toLowerCase()]!, r.m![3] ? +r.m![3] : undefined);
    if (d) out.date = d;
    else out.invalid = true;
    text = r.text;
    dateFound = true;
  } else if ((r = take(text, /\b(?:yesterday|kecha)\b/i)).m) {
    out.date = now.minus({ days: 1 }).toFormat('yyyy-LL-dd');
    text = r.text;
    dateFound = true;
  } else if ((r = take(text, /\b(?:day\s+after\s+tomorrow|indinga)\b/i)).m) {
    out.date = now.plus({ days: 2 }).toFormat('yyyy-LL-dd');
    text = r.text;
    dateFound = true;
  } else if ((r = take(text, /\b(?:tomorrow|ertaga)\b/i)).m) {
    out.date = now.plus({ days: 1 }).toFormat('yyyy-LL-dd');
    text = r.text;
    dateFound = true;
  } else if ((r = take(text, /\b(?:today|bugun)\b/i)).m) {
    out.date = now.toFormat('yyyy-LL-dd');
    text = r.text;
    dateFound = true;
  } else if ((r = take(text, /\b(\d{1,3})\s+(?:days?\s+from\s+now|kundan\s+keyin)\b/i)).m) {
    out.date = now.plus({ days: +r.m![1]! }).toFormat('yyyy-LL-dd');
    text = r.text;
    dateFound = true;
  } else if ((r = take(text, new RegExp(`\\b(?:(?:next|on|keyingi)\\s+)?(${WD})(?:\\s+kuni)?\\b`, 'i'))).m && !out.recurrence) {
    out.date = nextWeekday(now, WEEKDAYS[r.m![1]!.toLowerCase()]!).toFormat('yyyy-LL-dd');
    text = r.text;
    dateFound = true;
  }

  // ---- period words (affect bare hours) -----------------------------------------------------------------------
  let period: 'am' | 'pm' | 'night' | null = null;
  if ((r = take(text, /\b(?:in\s+the\s+morning|morning|ertalab(?:ki)?)\b/i)).m) {
    period = 'am';
    text = r.text;
  } else if ((r = take(text, /\b(?:in\s+the\s+afternoon|afternoon|tushdan\s+keyin|in\s+the\s+evening|evening|tonight|kechqurun|kechki)\b/i)).m) {
    period = 'pm';
    text = r.text;
  } else if ((r = take(text, /\b(?:at\s+night|night|kechasi|tunda)\b/i)).m) {
    period = 'night';
    text = r.text;
  }

  // ---- time of day --------------------------------------------------------------------------------------------
  let hour: number | undefined;
  let minute = 0;
  let mer: 'am' | 'pm' | undefined;
  let zeroPadded = false;
  let twentyFourHourHint = false;
  if ((r = take(text, /\b(?:at\s+|soat\s+)?(\d{1,2})[:.](\d{2})\s*(am|pm)?(?:\s*(?:da|dan|ga))?\b/i)).m) {
    hour = +r.m![1]!;
    minute = +r.m![2]!;
    mer = r.m![3]?.toLowerCase() as 'am' | 'pm' | undefined;
    zeroPadded = r.m![1]!.length === 2 && r.m![1]!.startsWith('0');
    twentyFourHourHint = hour >= 13 || zeroPadded;
    text = r.text;
  } else if ((r = take(text, /\b(?:at|soat)\s+(\d{1,2})\s*(am|pm)?(?:\s*(?:da|dan|ga))?\b/i)).m) {
    hour = +r.m![1]!;
    mer = r.m![2]?.toLowerCase() as 'am' | 'pm' | undefined;
    twentyFourHourHint = hour >= 13;
    text = r.text;
  } else if ((r = take(text, /\b(\d{1,2})\s*(am|pm)\b/i)).m) {
    hour = +r.m![1]!;
    mer = r.m![2]!.toLowerCase() as 'am' | 'pm';
    text = r.text;
  } else if ((r = take(text, new RegExp(`\\bat\\s+(${NW})(?:\\s+o'clock)?(?:\\s+(am|pm))?\\b`, 'i'))).m) {
    hour = NUM_WORDS[r.m![1]!.toLowerCase()]!;
    mer = r.m![2]?.toLowerCase() as 'am' | 'pm' | undefined;
    text = r.text;
  } else if ((r = take(text, /\b(\d{1,2})\s+(?:da|ga)\b/i)).m) {
    hour = +r.m![1]!;
    twentyFourHourHint = hour >= 13;
    text = r.text;
  } else if ((r = take(text, /\b(?:at\s+noon|noon|tushda|tush\s+payti)\b/i)).m) {
    hour = 12;
    minute = 0;
    mer = 'pm';
    text = r.text;
  } else if ((r = take(text, /\b(?:at\s+midnight|midnight|yarim\s+tunda)\b/i)).m) {
    hour = 0;
    minute = 0;
    twentyFourHourHint = true;
    text = r.text;
  }

  if (hour !== undefined) {
    if (hour > 23 || minute > 59) {
      out.invalid = true;
    } else if (mer === 'pm' || mer === 'am') {
      if (hour > 12) out.invalid = true;
      else if (mer === 'pm' && hour < 12) hour += 12;
      else if (mer === 'am' && hour === 12) hour = 0;
    } else if (period && hour <= 12 && !twentyFourHourHint) {
      if (period === 'pm' && hour < 12) hour += 12;
      else if (period === 'am' && hour === 12) hour = 0;
      else if (period === 'night') {
        if (hour >= 6 && hour < 12) hour += 12;
        else if (hour === 12) hour = 0;
      }
    } else if (!twentyFourHourHint && hour >= 1 && hour <= 6) {
      out.ambiguousHour = hour; // 1..6 with no clue: morning or afternoon?
    }
    // 7..11 default to morning, 12 to noon, 0 and 13..23 are already 24h.
    if (!out.invalid && out.ambiguousHour === undefined) out.time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  // ---- default the date when only a time (or only a weekday recurrence) was given --------------------------------
  if (out.time && !dateFound) {
    const today = now.toFormat('yyyy-LL-dd');
    const candidate = DateTime.fromISO(`${today}T${out.time}`, { zone: ctx.timezone });
    out.date = candidate > now ? today : now.plus({ days: 1 }).toFormat('yyyy-LL-dd');
  }
  if (recurWeekday !== undefined && !dateFound) out.date = nextWeekday(now, recurWeekday, true, out.time).toFormat('yyyy-LL-dd');
  if (out.recurrence?.freq === 'weekly' && !out.recurrence.byWeekday && out.date) out.recurrence.byWeekday = [DateTime.fromISO(out.date).weekday];

  out.rest = squash(text);
  return out;
}

/** Next date with the given ISO weekday, strictly after today (or today if `allowToday` and the time is still ahead). */
function nextWeekday(now: DateTime, wd: number, allowToday = false, time?: string): DateTime {
  let d = now.startOf('day');
  if (allowToday && now.weekday === wd && time) {
    const [h, m] = time.split(':').map(Number);
    if (now.set({ hour: h!, minute: m!, second: 0, millisecond: 0 }) > now) return d;
  }
  do d = d.plus({ days: 1 });
  while (d.weekday !== wd);
  return d;
}
