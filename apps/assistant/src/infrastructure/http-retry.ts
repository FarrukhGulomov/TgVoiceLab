/** Statuses that mean "the service is busy or hiccuping right now", worth another try within a second or two. */
const TRANSIENT = new Set([429, 500, 502, 503, 504]);

/**
 * One request, retried (twice at most, short pauses) when the service is overloaded (HTTP 429/5xx) or the network blinked. A rejected request
 * (400/401/403/404) is final: retrying cannot fix it. `makeInit` builds fresh options per attempt, so each attempt gets its own timeout.
 */
export async function fetchWithRetry(
  f: typeof fetch,
  url: string,
  makeInit: () => RequestInit,
  o: { retries?: number; delaysMs?: number[]; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Response> {
  const retries = o.retries ?? 2;
  const delays = o.delaysMs ?? [600, 1800];
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined;
    let err: unknown;
    try {
      res = await f(url, makeInit());
    } catch (e) {
      err = e;
    }
    if (res && (res.ok || !TRANSIENT.has(res.status))) return res;
    if (attempt >= retries) {
      if (res) return res;
      throw err;
    }
    // A timeout (the model took too long) is not retried: it would only double the wait the owner already sat through.
    if (!res && (err as { name?: string })?.name === 'TimeoutError') throw err;
    await sleep(delays[Math.min(attempt, delays.length - 1)] ?? 1000);
  }
}
