export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

/** Deterministic clock for tests. Time only moves when told to. */
export class FakeClock implements Clock {
  constructor(private t: Date) {}
  now(): Date {
    return new Date(this.t);
  }
  set(t: Date | string) {
    this.t = new Date(t);
  }
  advanceMs(ms: number) {
    this.t = new Date(this.t.getTime() + ms);
  }
}
