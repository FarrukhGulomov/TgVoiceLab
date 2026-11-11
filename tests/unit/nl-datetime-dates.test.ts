import { describe, expect, it } from 'vitest';
import { extractWhen } from '../../apps/assistant/src/modules/messaging/nl-datetime.js';

// Sat 2026-10-17 11:30 in Asia/Samarkand (UTC+5)
const ctx = { receivedAt: new Date('2026-10-17T06:30:00Z'), timezone: 'Asia/Samarkand' };
const w = (s: string) => extractWhen(s, ctx);

describe('explicit dates', () => {
  it.each([
    ['sinov 15.10.2026 10:00', '2026-10-15', '10:00', 'sinov'],
    ['sinov 15/10/2026 soat 18:30', '2026-10-15', '18:30', 'sinov'],
    ['sinov 3.1.2027 09:00', '2027-01-03', '09:00', 'sinov'],
    ['hisobot 22-oktyabr 10:00', '2026-10-22', '10:00', 'hisobot'],
    ['hisobot 20 oktyabr soat 14:00', '2026-10-20', '14:00', 'hisobot'],
    ['hisobot 5-yanvar 2027 09:00', '2027-01-05', '09:00', 'hisobot'],
    ['report October 25 at 15:00', '2026-10-25', '15:00', 'report'],
    ['report 25th Oct 15:00', '2026-10-25', '15:00', 'report'],
    ['report on 1 December 2026 at 08:00', '2026-12-01', '08:00', 'report'],
  ])('%s -> %s %s', (input, date, time, rest) => {
    const r = w(input);
    expect(r).toMatchObject({ date, time });
    expect(
      r.rest
        .replace(/\b(?:on|at|soat)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim(),
    ).toBe(rest);
    expect(r.invalid).toBeUndefined();
  });

  it('a date without a year means the next such date (this year if still ahead, else next year)', () => {
    expect(w('x 20-oktyabr 10:00').date).toBe('2026-10-20');
    expect(w('x 15-oktyabr 10:00').date).toBe('2027-10-15'); // 15 Oct has passed on the 17th
    expect(w('x 17-oktyabr 10:00').date).toBe('2026-10-17'); // today is still ahead
  });

  it('kecha / yesterday are dates in the past, not "tonight"', () => {
    expect(w('x kecha 10:00')).toMatchObject({ date: '2026-10-16', time: '10:00' });
    expect(w('x yesterday 10:00')).toMatchObject({ date: '2026-10-16', time: '10:00' });
    expect(w('x kechqurun 8').date).toBeUndefined(); // kechqurun is "evening", unaffected
  });

  it('impossible dates are flagged invalid, never silently shifted', () => {
    expect(w('x 31.02.2026 10:00').invalid).toBe(true);
    expect(w('x 31-aprel 10:00').invalid).toBe(true);
    expect(w('x 32.01.2026 10:00').invalid).toBe(true);
  });

  it('plain times and the older forms still work', () => {
    expect(w('x 15.10 ga').time).toBe('15:10'); // a bare hh.mm is still a time of day
    expect(w('x ertaga 18:00')).toMatchObject({ date: '2026-10-18', time: '18:00' });
    expect(w('x 2026-10-20 09:15')).toMatchObject({ date: '2026-10-20', time: '09:15' });
    expect(w('x bugun 15:10')).toMatchObject({ date: '2026-10-17', time: '15:10' });
  });
});
