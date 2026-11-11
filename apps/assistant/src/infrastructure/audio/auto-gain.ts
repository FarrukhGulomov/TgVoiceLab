/**
 * Raises quiet speech on a phone line towards a steady level (at most `maxGain` times, never clipping). Only speech moves the loudness
 * estimate, so the noise floor is not amplified. Used before audio goes to a recogniser, which mishears quiet speech.
 */
export class AutoGain {
  #level = 0;
  constructor(private readonly o: { target?: number; maxGain?: number; speechFloor?: number } = {}) {}

  process(pcm: Uint8Array): Uint8Array {
    const n = Math.floor(pcm.length / 2);
    if (!n) return pcm;
    const src = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const x = src.getInt16(i * 2, true);
      sum += x * x;
    }
    const rms = Math.sqrt(sum / n);
    if (rms > (this.o.speechFloor ?? 200)) this.#level = this.#level ? this.#level * 0.9 + rms * 0.1 : rms;
    const g = this.#level ? Math.min(this.o.maxGain ?? 6, Math.max(1, (this.o.target ?? 3000) / this.#level)) : 1;
    if (g < 1.05) return pcm;
    const out = new Uint8Array(pcm.length);
    const dst = new DataView(out.buffer);
    for (let i = 0; i < n; i++) dst.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(src.getInt16(i * 2, true) * g))), true);
    return out;
  }
}
