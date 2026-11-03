import { describe, expect, it } from 'vitest';
import { fetchWithRetry } from '../../apps/assistant/src/infrastructure/http-retry.js';

const res = (status: number) => new Response('x', { status });
const run = (script: Array<number | Error>) => {
  const calls: number[] = [];
  const f = (async () => {
    const s = script[calls.length] ?? 200;
    calls.push(calls.length);
    if (s instanceof Error) throw s;
    return res(s);
  }) as unknown as typeof fetch;
  const slept: number[] = [];
  const go = () => fetchWithRetry(f, 'http://x', () => ({}), { sleep: async (ms) => void slept.push(ms) });
  return { go, calls, slept };
};

describe('fetchWithRetry: an overloaded service gets another try, a refusal does not', () => {
  it('HTTP 503 twice then 200: three attempts, the owner never sees the busy answers', async () => {
    const r = run([503, 503, 200]);
    expect((await r.go()).status).toBe(200);
    expect(r.calls).toHaveLength(3);
    expect(r.slept).toEqual([600, 1800]);
  });
  it('still 503 after the retries: the last answer is returned (the caller reports it)', async () => {
    const r = run([503, 503, 503]);
    expect((await r.go()).status).toBe(503);
    expect(r.calls).toHaveLength(3);
  });
  it('a rejected request (401, 404) is final at once', async () => {
    for (const s of [400, 401, 403, 404]) {
      const r = run([s]);
      expect((await r.go()).status).toBe(s);
      expect(r.calls).toHaveLength(1);
    }
  });
  it('a network blink is retried; a timeout is not (the owner already waited that long)', async () => {
    const blink = run([new TypeError('fetch failed'), 200]);
    expect((await blink.go()).status).toBe(200);
    const slow = run([Object.assign(new Error('t'), { name: 'TimeoutError' }), 200]);
    await expect(slow.go()).rejects.toThrow('t');
    expect(slow.calls).toHaveLength(1);
  });
});
