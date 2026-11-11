/**
 * Streaming PCM16 (s16le, mono) resampler: windowed-sinc low-pass + fractional-position interpolation.
 * Pure and deterministic. Used by the audio bridge between the call adapter (48 kHz, 10 ms frames) and an AI voice model whose
 * sample rate is a parameter (never hard-coded here: the model's format must be verified against its documentation).
 */

const HALF_TAPS = 24; // 48 taps total: good stop-band for speech, cheap enough for real time

export class StreamingResampler {
  readonly #step: number; // input samples consumed per output sample
  readonly #cutoff: number; // fraction of the input Nyquist that is kept (anti-aliasing when downsampling)
  #buf: number[] = new Array<number>(HALF_TAPS).fill(0); // zero history so the first output is well defined
  #pos = HALF_TAPS; // fractional index (in #buf) of the next output sample
  #carry: number | null = null; // odd trailing byte of the previous chunk

  constructor(
    readonly fromHz: number,
    readonly toHz: number,
  ) {
    if (!Number.isInteger(fromHz) || !Number.isInteger(toHz) || fromHz < 8000 || toHz < 8000 || fromHz > 96000 || toHz > 96000)
      throw new Error('sample rates must be integers between 8000 and 96000');
    this.#step = fromHz / toHz;
    this.#cutoff = Math.min(1, toHz / fromHz) * 0.95;
  }

  /** Consume s16le bytes of any length; returns the s16le bytes that can be produced so far. */
  process(input: Uint8Array): Uint8Array {
    let bytes = input;
    if (this.#carry !== null) {
      const joined = new Uint8Array(input.length + 1);
      joined[0] = this.#carry;
      joined.set(input, 1);
      bytes = joined;
      this.#carry = null;
    }
    if (bytes.length % 2 === 1) {
      this.#carry = bytes[bytes.length - 1]!;
      bytes = bytes.subarray(0, bytes.length - 1);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < bytes.length; i += 2) this.#buf.push(view.getInt16(i, true));

    const out: number[] = [];
    const c = this.#cutoff;
    while (Math.floor(this.#pos) + HALF_TAPS < this.#buf.length) {
      const base = Math.floor(this.#pos);
      const frac = this.#pos - base;
      let acc = 0;
      for (let k = -HALF_TAPS + 1; k <= HALF_TAPS; k++) {
        const x = k - frac; // distance (in input samples) from the output instant
        const w = 0.5 + 0.5 * Math.cos((Math.PI * x) / (HALF_TAPS + 1)); // Hann window
        const arg = Math.PI * c * x;
        const sinc = x === 0 ? c : Math.sin(arg) / (Math.PI * x);
        acc += this.#buf[base + k]! * sinc * w;
      }
      out.push(Math.max(-32768, Math.min(32767, Math.round(acc))));
      this.#pos += this.#step;
    }
    const drop = Math.floor(this.#pos) - HALF_TAPS;
    if (drop > 0) {
      this.#buf = this.#buf.slice(drop);
      this.#pos -= drop;
    }
    const res = new Uint8Array(out.length * 2);
    const rv = new DataView(res.buffer);
    out.forEach((v, i) => rv.setInt16(i * 2, v, true));
    return res;
  }
}

/** Re-groups arbitrary-length audio into exact fixed-size frames (e.g. 960 bytes = 10 ms at 48 kHz mono s16le). */
export class FrameAssembler {
  #pending: Uint8Array = new Uint8Array(0);
  constructor(readonly frameBytes: number) {
    if (!Number.isInteger(frameBytes) || frameBytes <= 0 || frameBytes % 2 !== 0) throw new Error('frameBytes must be a positive even integer');
  }
  push(chunk: Uint8Array): Uint8Array[] {
    const joined = new Uint8Array(this.#pending.length + chunk.length);
    joined.set(this.#pending, 0);
    joined.set(chunk, this.#pending.length);
    const frames: Uint8Array[] = [];
    let off = 0;
    while (joined.length - off >= this.frameBytes) {
      frames.push(joined.slice(off, off + this.frameBytes));
      off += this.frameBytes;
    }
    this.#pending = joined.slice(off);
    return frames;
  }
  /** Bytes held back waiting for a full frame (e.g. to be dropped on barge-in/flush). */
  get pendingBytes(): number {
    return this.#pending.length;
  }
  clear(): void {
    this.#pending = new Uint8Array(0);
  }
}
