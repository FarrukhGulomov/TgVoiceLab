import { describe, expect, it } from 'vitest';
import { FrameAssembler, StreamingResampler } from '../../apps/assistant/src/modules/calls/audio/resampler.js';

function sine(hz: number, rate: number, seconds: number, amp = 12000): Uint8Array {
  const n = Math.round(rate * seconds);
  const out = new Uint8Array(n * 2);
  const v = new DataView(out.buffer);
  for (let i = 0; i < n; i++) v.setInt16(i * 2, Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * amp), true);
  return out;
}
const samples = (b: Uint8Array) => {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return Array.from({ length: b.length / 2 }, (_, i) => v.getInt16(i * 2, true));
};
const rms = (b: Uint8Array, skip = 0) => {
  const s = samples(b).slice(skip);
  return Math.sqrt(s.reduce((a, x) => a + x * x, 0) / s.length);
};
const zeroCrossings = (b: Uint8Array) => {
  const s = samples(b);
  let z = 0;
  for (let i = 1; i < s.length; i++) if (s[i - 1]! < 0 !== s[i]! < 0) z++;
  return z;
};

describe('StreamingResampler', () => {
  it('48k -> 24k keeps length ratio, level and frequency of a speech-band tone', () => {
    const out = new StreamingResampler(48000, 24000).process(sine(1000, 48000, 1));
    expect(Math.abs(out.length / 2 - 24000)).toBeLessThanOrEqual(30);
    expect(rms(out, 200) / (12000 / Math.SQRT2)).toBeGreaterThan(0.97);
    expect(rms(out, 200) / (12000 / Math.SQRT2)).toBeLessThan(1.03);
    expect(Math.abs(zeroCrossings(out) - 2000)).toBeLessThanOrEqual(4);
  });

  it('24k -> 48k keeps length ratio, level and frequency', () => {
    const out = new StreamingResampler(24000, 48000).process(sine(1000, 24000, 1));
    expect(Math.abs(out.length / 2 - 48000)).toBeLessThanOrEqual(60);
    expect(rms(out, 400) / (12000 / Math.SQRT2)).toBeGreaterThan(0.97);
    expect(Math.abs(zeroCrossings(out) - 2000)).toBeLessThanOrEqual(4);
  });

  it('attenuates content above the target Nyquist instead of aliasing it into the band (48k -> 16k, 12 kHz tone)', () => {
    const out = new StreamingResampler(48000, 16000).process(sine(12000, 48000, 1));
    expect(rms(out, 200)).toBeLessThan(12000 * 0.02); // >30 dB down
  });

  it('streaming in arbitrary (odd) chunk sizes equals one-shot processing', () => {
    const input = sine(700, 48000, 0.5);
    const oneShot = new StreamingResampler(48000, 24000).process(input);
    const r = new StreamingResampler(48000, 24000);
    const parts: Uint8Array[] = [];
    for (let off = 0, n = 1; off < input.length; off += n, n = ((n * 7 + 3) % 1999) + 1) parts.push(r.process(input.subarray(off, off + n)));
    const total = parts.reduce((a, p) => a + p.length, 0);
    const joined = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      joined.set(p, o);
      o += p.length;
    }
    expect(joined).toEqual(oneShot);
  });

  it('never overflows: full-scale input is clamped, not wrapped', () => {
    const out = new StreamingResampler(24000, 48000).process(sine(3000, 24000, 0.2, 32767));
    expect(Math.max(...samples(out))).toBeLessThanOrEqual(32767);
    expect(Math.min(...samples(out))).toBeGreaterThanOrEqual(-32768);
  });

  it('rejects absurd sample rates', () => {
    expect(() => new StreamingResampler(100, 24000)).toThrow();
    expect(() => new StreamingResampler(48000, 1.5)).toThrow();
  });
});

describe('FrameAssembler', () => {
  it('emits exact 960-byte frames and holds the remainder', () => {
    const a = new FrameAssembler(960);
    expect(a.push(new Uint8Array(500))).toHaveLength(0);
    const frames = a.push(new Uint8Array(1500));
    expect(frames).toHaveLength(2);
    expect(frames.every((f) => f.length === 960)).toBe(true);
    expect(a.pendingBytes).toBe(80);
    a.clear();
    expect(a.pendingBytes).toBe(0);
  });
  it('preserves byte order across pushes', () => {
    const a = new FrameAssembler(4);
    const out = [...a.push(Uint8Array.from([1, 2, 3])), ...a.push(Uint8Array.from([4, 5, 6, 7, 8]))];
    expect(out.map((f) => [...f])).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ]);
  });
  it('rejects invalid frame sizes', () => {
    expect(() => new FrameAssembler(0)).toThrow();
    expect(() => new FrameAssembler(3)).toThrow();
  });
});
