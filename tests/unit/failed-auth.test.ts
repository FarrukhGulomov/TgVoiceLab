import { describe, expect, it } from 'vitest';
import { FailedAuthLimiter } from '../../apps/assistant/src/http/failed-auth.js';

describe('audit F-17: failed authentication is limited per source', () => {
  it('one noisy source is throttled without affecting another source', () => {
    const l = new FailedAuthLimiter({ auditPerWindow: 3, throttleAfter: 10, windowMs: 60_000, auditGlobalPerWindow: 100 });
    let last = { audit: false, throttle: false, flushSuppressed: 0 };
    for (let i = 0; i < 50; i++) last = l.onFailure(1000 + i, '203.0.113.9');
    expect(last.throttle).toBe(true);
    const other = l.onFailure(1100, '198.51.100.4'); // a different client making its first mistake
    expect(other).toMatchObject({ audit: true, throttle: false });
  });

  it('audits only the first few failures of a source per window, and starts over when the window rolls', () => {
    const l = new FailedAuthLimiter({ auditPerWindow: 2, throttleAfter: 5, windowMs: 1000, auditGlobalPerWindow: 100 });
    expect([1, 2, 3].map((i) => l.onFailure(i, 'a').audit)).toEqual([true, true, false]);
    expect(l.onFailure(5000, 'a')).toMatchObject({ audit: true, throttle: false }); // new window
  });

  it('caps audit rows across all sources and reports the suppressed count once, when the window rolls over', () => {
    const l = new FailedAuthLimiter({ auditPerWindow: 5, throttleAfter: 50, windowMs: 1000, auditGlobalPerWindow: 4 });
    const audited = Array.from({ length: 10 }, (_, i) => l.onFailure(10 + i, `src-${i}`).audit).filter(Boolean).length;
    expect(audited).toBe(4);
    expect(l.onFailure(5000, 'src-new').flushSuppressed).toBe(6);
    expect(l.onFailure(5001, 'src-new').flushSuppressed).toBe(0);
  });

  it('remembers a bounded number of sources', () => {
    const l = new FailedAuthLimiter({ maxSources: 3, auditPerWindow: 1, throttleAfter: 100, windowMs: 60_000, auditGlobalPerWindow: 1000 });
    for (let i = 0; i < 20; i++) l.onFailure(i, `s${i}`);
    // the oldest sources were forgotten: s0 counts as new again
    expect(l.onFailure(100, 's0').audit).toBe(true);
  });
});
