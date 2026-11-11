import { pino, type Logger } from 'pino';

/**
 * Keys whose values must never reach logs, compared after normalizing (lowercase, alphanumerics only) so
 * `api_hash`, `apiHash` and `API-HASH` all match while `reasonCode` and `relationship` do not.
 */
const SENSITIVE_EXACT = new Set([
  'apihash',
  'apikey',
  'authorization',
  'cookie',
  'password',
  'otp',
  'twofa',
  'accesshash',
  'callkey',
  'ga',
  'gb',
  'ip',
  'ipaddress',
  'remoteip',
  'participantip',
  'transcript',
  'content',
  'text',
  'audio',
  'samples',
  'payload',
  'raw',
  'body',
  'session',
  'sessionstring',
  'phonecode',
  'logincode',
  'plaintext',
]);
const SENSITIVE_SUFFIX = ['token', 'secret', 'password', 'apikey'];
const isSensitiveKey = (k: string) => {
  const n = k.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SENSITIVE_EXACT.has(n) || SENSITIVE_SUFFIX.some((s) => n.endsWith(s));
};

export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (value && typeof value === 'object') {
    if (value instanceof Uint8Array) return `[bytes:${value.byteLength}]`;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = isSensitiveKey(k) ? '[redacted]' : scrub(v, depth + 1);
    return out;
  }
  if (typeof value === 'string') return redactString(value);
  return value;
}

/** Last-resort pattern scrubbing for strings that slip into messages. */
export function redactString(s: string): string {
  return s
    .replace(/\b\d{9,10}:[A-Za-z0-9_-]{30,}\b/g, '[redacted-bot-token]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[redacted-api-key]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]')
    .replace(/\b1[A-Za-z0-9_-]{200,}={0,2}/g, '[redacted-session]');
}

export function createLogger(level: string, destination?: NodeJS.WritableStream): Logger {
  const opts = {
    level,
    base: { service: 'tgvl-assistant' },
    formatters: { log: (o: Record<string, unknown>) => scrub(o) as Record<string, unknown> },
    hooks: {
      // Message strings (and printf-style args) bypass `formatters.log`, so scrub them here.
      logMethod(this: Logger, args: unknown[], method: (...a: unknown[]) => void) {
        method.apply(
          this,
          args.map((a) => (typeof a === 'string' ? redactString(a) : a)),
        );
      },
    },
    redact: { paths: ['req.headers.authorization', 'req.headers.cookie', '*.apiHash', '*.session'], censor: '[redacted]' },
  };
  return destination ? pino(opts, destination) : pino(opts);
}
export type { Logger };
