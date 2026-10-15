/**
 * Versioned binary media envelope for the gateway <-> bridge channel (spec §5.1):
 *   [u32 BE payloadLength][u32 BE headerLength][header: UTF-8 JSON][payload: PCM bytes]
 * Limits: header <= 4 KiB, frame (payload) <= 64 KiB. Anything malformed, oversize, wrong-call or
 * out-of-sequence is rejected; callers must treat a rejection as fatal for the call.
 */
import { z } from 'zod';
import { PcmFrameSchema } from './call.js';

export const MAX_HEADER_BYTES = 4 * 1024;
export const MAX_PAYLOAD_BYTES = 64 * 1024;
const PREFIX_BYTES = 8;

export class MediaFrameError extends Error {
  constructor(
    readonly code:
      | 'truncated'
      | 'header_too_large'
      | 'payload_too_large'
      | 'bad_header'
      | 'odd_sample_bytes'
      | 'wrong_call'
      | 'out_of_sequence',
    message: string,
  ) {
    super(message);
    this.name = 'MediaFrameError';
  }
}

export type MediaFrameHeader = z.infer<typeof PcmFrameSchema>;

export function encodeMediaFrame(header: MediaFrameHeader, samples: Uint8Array): Uint8Array {
  PcmFrameSchema.parse(header);
  if (samples.byteLength % 2 !== 0) throw new MediaFrameError('odd_sample_bytes', 's16le payload must be even-sized');
  if (samples.byteLength > MAX_PAYLOAD_BYTES) throw new MediaFrameError('payload_too_large', 'payload exceeds 64 KiB');
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  if (headerBytes.byteLength > MAX_HEADER_BYTES) throw new MediaFrameError('header_too_large', 'header exceeds 4 KiB');
  const out = new Uint8Array(PREFIX_BYTES + headerBytes.byteLength + samples.byteLength);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, samples.byteLength, false);
  dv.setUint32(4, headerBytes.byteLength, false);
  out.set(headerBytes, PREFIX_BYTES);
  out.set(samples, PREFIX_BYTES + headerBytes.byteLength);
  return out;
}

export function decodeMediaFrame(buf: Uint8Array): { header: MediaFrameHeader; samples: Uint8Array } {
  if (buf.byteLength < PREFIX_BYTES) throw new MediaFrameError('truncated', 'shorter than length prefix');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const payloadLength = dv.getUint32(0, false);
  const headerLength = dv.getUint32(4, false);
  if (headerLength > MAX_HEADER_BYTES) throw new MediaFrameError('header_too_large', 'header exceeds 4 KiB');
  if (payloadLength > MAX_PAYLOAD_BYTES) throw new MediaFrameError('payload_too_large', 'payload exceeds 64 KiB');
  if (payloadLength % 2 !== 0) throw new MediaFrameError('odd_sample_bytes', 's16le payload must be even-sized');
  if (buf.byteLength !== PREFIX_BYTES + headerLength + payloadLength)
    throw new MediaFrameError('truncated', 'length prefix does not match buffer size');
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(PREFIX_BYTES, PREFIX_BYTES + headerLength)));
  } catch {
    throw new MediaFrameError('bad_header', 'header is not valid UTF-8 JSON');
  }
  const header = PcmFrameSchema.safeParse(parsed);
  if (!header.success) throw new MediaFrameError('bad_header', 'header failed schema validation');
  return { header: header.data, samples: buf.slice(PREFIX_BYTES + headerLength) };
}

/** Stateful validator: enforces call identity and strictly increasing sequence/timestamps. */
export class MediaFrameSequencer {
  private last: { seq: number; ts: number } | null = null;
  constructor(private readonly expectedCallId: string) {}
  accept(header: MediaFrameHeader): void {
    if (header.callId !== this.expectedCallId) throw new MediaFrameError('wrong_call', 'frame for a different call');
    if (this.last && (header.sequence <= this.last.seq || header.monotonicTimestampUs < this.last.ts))
      throw new MediaFrameError('out_of_sequence', 'sequence or timestamp went backwards');
    this.last = { seq: header.sequence, ts: header.monotonicTimestampUs };
  }
}
