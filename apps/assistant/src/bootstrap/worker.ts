import type { ActiveCallRegistry } from '../modules/operations/operations.service.js';

export interface Lane {
  stop(): Promise<void>;
}

/**
 * A self-scheduling polling loop: the next tick is scheduled only AFTER the previous one finished, so ticks never overlap and a
 * slow tick cannot accumulate a backlog (audit F08). Errors are reported and polling continues. `stop()` prevents new ticks and
 * waits for the in-flight one.
 */
export function startLane(o: { name: string; intervalMs: number; run: () => Promise<unknown>; onError: (e: Error, lane: string) => void }): Lane {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inflight: Promise<void> = Promise.resolve();
  const tick = () => {
    if (stopped) return;
    inflight = (async () => {
      try {
        await o.run();
      } catch (e) {
        o.onError(e as Error, o.name);
      }
      if (!stopped) timer = setTimeout(tick, o.intervalMs);
    })();
  };
  timer = setTimeout(tick, o.intervalMs);
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inflight;
    },
  };
}

/**
 * Graceful shutdown: stop claiming new work, ask every live call to end (the supervisors then persist their final or
 * uncertain state), and wait for the lanes - all within a deadline. Whatever has not settled by then is recovered at the next
 * start by the orphaned-call reconciliation, which never redials.
 */
export async function drainWorker(a: { lanes: Lane[]; registry: ActiveCallRegistry; deadlineMs: number }): Promise<{ endedCalls: number; timedOut: boolean }> {
  let endedCalls = 0;
  const work = (async () => {
    // End live calls FIRST so lanes blocked on call supervision can finish.
    await Promise.allSettled(a.registry.all().map(async (c) => (await c.end('cancelled'), endedCalls++)));
    await Promise.allSettled(a.lanes.map((l) => l.stop()));
  })();
  let timedOut = false;
  await Promise.race([
    work,
    new Promise<void>((r) =>
      setTimeout(() => {
        timedOut = true;
        r();
      }, a.deadlineMs).unref(),
    ),
  ]);
  return { endedCalls, timedOut };
}
