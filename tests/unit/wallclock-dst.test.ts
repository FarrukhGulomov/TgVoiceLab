import { describe, expect, it } from 'vitest';
import { describeInstant, InvalidTimezoneError, resolveWallClock } from '../../apps/assistant/src/modules/scheduling/wallclock.js';
import { nextOccurrence } from '../../apps/assistant/src/modules/scheduling/recurrence.js';

const iso = (d: Date) => d.toISOString();

describe('wall-clock resolution (spec §7 DST policy)', () => {
  it('Asia/Samarkand (UTC+5, no DST): 09:00 local = 04:00Z', () => {
    const r = resolveWallClock('2026-10-16T09:00', 'Asia/Samarkand');
    expect(iso(r.utc)).toBe('2026-10-16T04:00:00.000Z');
    expect(r.kind).toBe('exact');
  });

  it('spring-forward gap uses the FIRST VALID time after the gap (02:30 does not exist -> 03:00 local)', () => {
    // America/New_York 2026-03-08: 02:00 -> 03:00. 02:30 is nonexistent.
    const r = resolveWallClock('2026-03-08T02:30', 'America/New_York');
    expect(r.kind).toBe('gap_shifted_forward');
    expect(iso(r.utc)).toBe('2026-03-08T07:00:00.000Z'); // 03:00 EDT
    expect(describeInstant(r.utc, 'America/New_York').time).toBe('03:00');
  });

  it('fall-back overlap picks the EARLIER instant (01:30 happens twice)', () => {
    // America/New_York 2026-11-01: 02:00 EDT -> 01:00 EST. 01:30 occurs at 05:30Z (EDT) and 06:30Z (EST).
    const r = resolveWallClock('2026-11-01T01:30', 'America/New_York');
    expect(r.kind).toBe('overlap_earlier');
    expect(iso(r.utc)).toBe('2026-11-01T05:30:00.000Z');
  });

  it('southern-hemisphere and half-hour transitions (Australia/Lord_Howe 30-min DST)', () => {
    // Lord Howe: 2026-10-04 02:00 -> 02:30 (30 minute gap). 02:15 does not exist.
    const r = resolveWallClock('2026-10-04T02:15', 'Australia/Lord_Howe');
    expect(r.kind).toBe('gap_shifted_forward');
    expect(describeInstant(r.utc, 'Australia/Lord_Howe').time).toBe('02:30');
  });

  it('ordinary times near a transition day are exact', () => {
    expect(resolveWallClock('2026-03-08T01:59', 'America/New_York').kind).toBe('exact');
    expect(resolveWallClock('2026-03-08T03:00', 'America/New_York').kind).toBe('exact');
    expect(resolveWallClock('2026-11-01T02:00', 'America/New_York').kind).toBe('exact');
  });

  it('rejects unknown timezones', () => {
    expect(() => resolveWallClock('2026-10-16T09:00', 'Mars/Olympus')).toThrow(InvalidTimezoneError);
  });
});

describe('recurrence keeps local wall-clock intent across DST', () => {
  const ny = 'America/New_York';
  it('daily 09:00 stays 09:00 local before and after spring-forward (UTC shifts by 1h)', () => {
    const rec = { freq: 'daily', interval: 1 } as const;
    const before = nextOccurrence('2026-03-01T09:00', ny, rec, new Date('2026-03-07T20:00:00Z'));
    const after = nextOccurrence('2026-03-01T09:00', ny, rec, before.utc);
    expect(iso(before.utc)).toBe('2026-03-08T13:00:00.000Z'); // Mar 8 09:00 EDT (UTC-4) — day of the change
    expect(iso(after.utc)).toBe('2026-03-09T13:00:00.000Z');
    const prev = nextOccurrence('2026-03-01T09:00', ny, rec, new Date('2026-03-06T20:00:00Z'));
    expect(iso(prev.utc)).toBe('2026-03-07T14:00:00.000Z'); // Mar 7 09:00 EST (UTC-5)
  });

  it('daily 02:30 on the gap day resolves to 03:00 then returns to 02:30 the next day', () => {
    const rec = { freq: 'daily', interval: 1 } as const;
    const gapDay = nextOccurrence('2026-03-01T02:30', ny, rec, new Date('2026-03-07T04:00:00Z'));
    expect(describeInstant(gapDay.utc, ny).date).toBe('2026-03-07');
    const g = nextOccurrence('2026-03-01T02:30', ny, rec, gapDay.utc);
    expect(g.kind).toBe('gap_shifted_forward');
    expect(describeInstant(g.utc, ny).time).toBe('03:00');
    const n = nextOccurrence('2026-03-01T02:30', ny, rec, g.utc);
    expect(describeInstant(n.utc, ny).time).toBe('02:30');
  });

  it('strictly after the reference instant (no double fire at the boundary)', () => {
    const rec = { freq: 'daily', interval: 1 } as const;
    const first = nextOccurrence('2026-10-16T09:00', 'Asia/Samarkand', rec, new Date('2026-10-16T03:00:00Z'));
    const second = nextOccurrence('2026-10-16T09:00', 'Asia/Samarkand', rec, first.utc);
    expect(iso(first.utc)).toBe('2026-10-16T04:00:00.000Z');
    expect(iso(second.utc)).toBe('2026-10-17T04:00:00.000Z');
  });

  it('weekly on Mon/Wed and every-other-week', () => {
    const tz = 'Asia/Samarkand';
    const mw = { freq: 'weekly', interval: 1, byWeekday: [1, 3] } as const;
    // 2026-10-16 is a Friday -> next Monday 2026-10-19
    const a = nextOccurrence('2026-10-05T09:00', tz, mw, new Date('2026-10-16T05:00:00Z'));
    expect(describeInstant(a.utc, tz).date).toBe('2026-10-19');
    const b = nextOccurrence('2026-10-05T09:00', tz, mw, a.utc);
    expect(describeInstant(b.utc, tz).date).toBe('2026-10-21');
    const biweekly = { freq: 'weekly', interval: 2, byWeekday: [1] } as const;
    const c = nextOccurrence('2026-10-05T09:00', tz, biweekly, new Date('2026-10-06T05:00:00Z'));
    expect(describeInstant(c.utc, tz).date).toBe('2026-10-19');
  });

  it('monthly on the 31st clamps to month end', () => {
    const tz = 'Asia/Samarkand';
    const rec = { freq: 'monthly', interval: 1 } as const;
    const feb = nextOccurrence('2026-01-31T09:00', tz, rec, new Date('2026-02-01T00:00:00Z'));
    expect(describeInstant(feb.utc, tz).date).toBe('2026-02-28');
    const mar = nextOccurrence('2026-01-31T09:00', tz, rec, feb.utc);
    expect(describeInstant(mar.utc, tz).date).toBe('2026-03-31');
  });
});
