/**
 * Bounds the work caused by failed API authentication (audit F19, F-17). Failures are counted PER SOURCE (client address): in each window
 * a source's first few failures are audited, the rest are only counted, and past a threshold that source gets a cheap 429 with no database
 * access at all. One noisy source therefore cannot throttle another source's answers or use up its audit rows. A global cap on audit rows
 * per window still protects the database when many sources fail at once; one summary row is written when that window rolls over.
 * Authenticated requests never pass through this limiter. The source table is bounded.
 */
interface SourceState {
  windowStart: number;
  failures: number;
}

export interface FailedAuthConfig {
  auditPerWindow: number;
  throttleAfter: number;
  windowMs: number;
  /** Audit rows allowed per window across ALL sources. */
  auditGlobalPerWindow: number;
  /** Sources remembered at once (the oldest is forgotten first). */
  maxSources: number;
}

export class FailedAuthLimiter {
  private readonly sources = new Map<string, SourceState>();
  private globalStart = 0;
  private globalAudited = 0;
  private globalSuppressed = 0;
  private readonly cfg: FailedAuthConfig;

  constructor(cfg: Partial<FailedAuthConfig> = {}) {
    this.cfg = { auditPerWindow: 5, throttleAfter: 30, windowMs: 60_000, auditGlobalPerWindow: 20, maxSources: 1000, ...cfg };
  }

  onFailure(nowMs: number, source = 'unknown'): { audit: boolean; throttle: boolean; flushSuppressed: number } {
    let flushSuppressed = 0;
    if (this.globalStart === 0 || nowMs - this.globalStart >= this.cfg.windowMs) {
      flushSuppressed = this.globalSuppressed;
      this.globalStart = nowMs;
      this.globalAudited = 0;
      this.globalSuppressed = 0;
    }
    let st = this.sources.get(source);
    if (!st || nowMs - st.windowStart >= this.cfg.windowMs) st = { windowStart: nowMs, failures: 0 };
    st.failures++;
    this.sources.delete(source); // re-insert: the Map order is the age order
    this.sources.set(source, st);
    while (this.sources.size > this.cfg.maxSources) this.sources.delete(this.sources.keys().next().value as string);

    const wanted = st.failures <= this.cfg.auditPerWindow;
    const audit = wanted && this.globalAudited < this.cfg.auditGlobalPerWindow;
    if (audit) this.globalAudited++;
    else this.globalSuppressed++;
    return { audit, throttle: st.failures > this.cfg.throttleAfter, flushSuppressed };
  }
}
