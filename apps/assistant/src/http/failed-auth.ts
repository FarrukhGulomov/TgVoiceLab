/**
 * Bounds the work caused by failed API authentication (audit F19). In each window the first few failures are audited, the rest are
 * only counted (one summary row is written when the window rolls over), and past a threshold the answer is a cheap 429 with no
 * database access at all. Authenticated requests never pass through this limiter.
 */
export class FailedAuthLimiter {
  private windowStart = 0;
  private failures = 0;
  private suppressed = 0;
  constructor(
    private readonly cfg: { auditPerWindow: number; throttleAfter: number; windowMs: number } = { auditPerWindow: 5, throttleAfter: 30, windowMs: 60_000 },
  ) {}

  onFailure(nowMs: number): { audit: boolean; throttle: boolean; flushSuppressed: number } {
    let flushSuppressed = 0;
    if (this.windowStart === 0 || nowMs - this.windowStart >= this.cfg.windowMs) {
      flushSuppressed = this.suppressed;
      this.windowStart = nowMs;
      this.failures = 0;
      this.suppressed = 0;
    }
    this.failures++;
    const audit = this.failures <= this.cfg.auditPerWindow;
    if (!audit) this.suppressed++;
    return { audit, throttle: this.failures > this.cfg.throttleAfter, flushSuppressed };
  }
}
