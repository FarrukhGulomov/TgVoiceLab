import { describe, expect, it } from 'vitest';
import { decodeMediaFrame, encodeMediaFrame, MAX_HEADER_BYTES, MAX_PAYLOAD_BYTES, MediaFrameError, MediaFrameSequencer, type MediaFrameHeader } from '@tgvl/contracts';

const callId = '11111111-1111-4111-8111-111111111111';
const hdr = (o: Partial<MediaFrameHeader> = {}): MediaFrameHeader => ({ callId, sequence: 0, monotonicTimestampUs: 0, sampleRateHz: 24000, channels: 1, encoding: 's16le', ...o });
const pcm = (n: number) => new Uint8Array(n).map((_, i) => i % 251);

describe('media frame codec (spec §5.1)', () => {
  it('round-trips a 20 ms 24 kHz frame (480 samples / 960 bytes)', () => {
    const buf = encodeMediaFrame(hdr(), pcm(960));
    const { header, samples } = decodeMediaFrame(buf);
    expect(header).toEqual(hdr());
    expect(samples).toEqual(pcm(960));
  });
  it('round-trips a 20 ms 48 kHz frame (960 samples / 1920 bytes)', () => {
    const { samples } = decodeMediaFrame(encodeMediaFrame(hdr({ sampleRateHz: 48000 }), pcm(1920)));
    expect(samples.byteLength).toBe(1920);
  });
  it('rejects oversize payloads on encode and decode', () => {
    expect(() => encodeMediaFrame(hdr(), pcm(MAX_PAYLOAD_BYTES + 2))).toThrowError(MediaFrameError);
    const ok = encodeMediaFrame(hdr(), pcm(960));
    new DataView(ok.buffer).setUint32(0, MAX_PAYLOAD_BYTES + 2, false);
    expect(() => decodeMediaFrame(ok)).toThrowError(/exceeds 64 KiB/);
  });
  it('rejects oversize header', () => {
    const ok = encodeMediaFrame(hdr(), pcm(2));
    new DataView(ok.buffer).setUint32(4, MAX_HEADER_BYTES + 1, false);
    expect(() => decodeMediaFrame(ok)).toThrowError(/header exceeds/);
  });
  it('rejects odd-sized s16le payloads, truncation, and garbage headers', () => {
    expect(() => encodeMediaFrame(hdr(), pcm(3))).toThrowError(/even-sized/);
    const ok = encodeMediaFrame(hdr(), pcm(960));
    expect(() => decodeMediaFrame(ok.subarray(0, ok.length - 1))).toThrowError(/does not match/);
    expect(() => decodeMediaFrame(new Uint8Array(3))).toThrowError(/shorter/);
    const bad = new Uint8Array(ok);
    bad[8] = 0xff; // corrupt first JSON byte
    expect(() => decodeMediaFrame(bad)).toThrowError(/header/);
  });
  it('rejects unsupported sample rate / channels in header', () => {
    expect(() => encodeMediaFrame({ ...hdr(), sampleRateHz: 44100 as never }, pcm(2))).toThrow();
    expect(() => encodeMediaFrame({ ...hdr(), channels: 2 as never }, pcm(2))).toThrow();
  });
  it('sequencer enforces call identity and monotonic order', () => {
    const s = new MediaFrameSequencer(callId);
    s.accept(hdr({ sequence: 1, monotonicTimestampUs: 20_000 }));
    s.accept(hdr({ sequence: 2, monotonicTimestampUs: 40_000 }));
    expect(() => s.accept(hdr({ sequence: 2, monotonicTimestampUs: 60_000 }))).toThrowError(/backwards/);
    expect(() => s.accept(hdr({ sequence: 3, monotonicTimestampUs: 10_000 }))).toThrowError(/backwards/);
    expect(() => s.accept(hdr({ callId: '22222222-2222-4222-8222-222222222222', sequence: 9, monotonicTimestampUs: 99_999 }))).toThrowError(/different call/);
  });
});
