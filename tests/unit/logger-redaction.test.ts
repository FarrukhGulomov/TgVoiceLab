import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, redactString, scrub } from '../../apps/assistant/src/infrastructure/observability/logger.js';

describe('log redaction', () => {
  it('redacts sensitive keys at any depth and keeps benign look-alikes', () => {
    const out = scrub({
      reasonCode: 'policy.denied',
      relationship: 'x',
      apiHash: 'abc',
      nested: { access_hash: '123', session: 'S', arr: [{ otp: '12345', ok: 1 }] },
      participantIp: '1.2.3.4',
      transcript: 'hello',
      samples: new Uint8Array(10),
    }) as Record<string, any>;
    expect(out.reasonCode).toBe('policy.denied');
    expect(out.relationship).toBe('x');
    expect(out.apiHash).toBe('[redacted]');
    expect(out.nested.access_hash).toBe('[redacted]');
    expect(out.nested.session).toBe('[redacted]');
    expect(out.nested.arr[0].otp).toBe('[redacted]');
    expect(out.nested.arr[0].ok).toBe(1);
    expect(out.participantIp).toBe('[redacted]');
    expect(out.transcript).toBe('[redacted]');
    expect(out.samples).toBe('[redacted]');
  });

  it('scrubs token-shaped strings in free text', () => {
    expect(redactString('call failed sk-abcdefghijklmnopqrstuv end')).not.toMatch(/sk-abc/);
    expect(redactString('Authorization: Bearer abcdef1234567890')).toMatch(/Bearer \[redacted\]/);
  });

  it('end-to-end: secrets never appear in emitted JSON log lines', async () => {
    const chunks: string[] = [];
    const sink = new Writable({
      write(c, _e, cb) {
        chunks.push(c.toString());
        cb();
      },
    });
    const log = createLogger('info', sink);
    log.info({ apiHash: 'SECRETHASH', req: { headers: { authorization: 'Bearer SECRETTOKEN123' } }, callId: 'c1' }, 'event with Bearer SECRETTOKEN456 inside');
    const line = chunks.join('');
    expect(line).not.toContain('SECRETHASH');
    expect(line).not.toContain('SECRETTOKEN');
    expect(line).toContain('c1');
  });
});
