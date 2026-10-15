import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Application-level AEAD for sensitive free text. AES-256-GCM, random 96-bit nonce per message, key id embedded,
 * and caller-supplied AAD (context binding) so ciphertext copied to another owner/column fails authentication.
 * Wire format: `e1.<keyId>.<nonceB64u>.<ciphertext||tagB64u>`
 */
export interface KeyRing {
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
}

export class DecryptionError extends Error {
  constructor(message = 'decryption failed') {
    super(message);
    this.name = 'DecryptionError';
  }
}

export function parseKeyRing(json: string): KeyRing {
  const raw = JSON.parse(json) as { active: string; keys: Record<string, string> };
  const keys = new Map<string, Buffer>();
  for (const [id, b64] of Object.entries(raw.keys)) {
    const k = Buffer.from(b64, 'base64');
    if (k.length !== 32) throw new Error(`key ${id} must be 32 bytes`);
    keys.set(id, k);
  }
  if (!keys.has(raw.active)) throw new Error('active key id missing from key ring');
  return { activeKeyId: raw.active, keys };
}

export class Envelope {
  constructor(private readonly ring: KeyRing) {}

  encrypt(plaintext: string, aad: string): string {
    const key = this.ring.keys.get(this.ring.activeKeyId)!;
    const nonce = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, nonce);
    c.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
    const body = Buffer.concat([ct, c.getAuthTag()]);
    return `e1.${this.ring.activeKeyId}.${nonce.toString('base64url')}.${body.toString('base64url')}`;
  }

  decrypt(envelope: string, aad: string): string {
    const parts = envelope.split('.');
    if (parts.length !== 4 || parts[0] !== 'e1') throw new DecryptionError('unrecognized envelope');
    const [, keyId, nonceB64, bodyB64] = parts as [string, string, string, string];
    const key = this.ring.keys.get(keyId);
    if (!key) throw new DecryptionError('unknown key id');
    const body = Buffer.from(bodyB64, 'base64url');
    if (body.length < 16) throw new DecryptionError();
    try {
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(nonceB64, 'base64url'));
      d.setAAD(Buffer.from(aad, 'utf8'));
      d.setAuthTag(body.subarray(body.length - 16));
      return Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]).toString('utf8');
    } catch {
      throw new DecryptionError();
    }
  }

  /** True when the stored envelope uses a retired key and should be re-encrypted during rotation. */
  needsRotation(envelope: string): boolean {
    return envelope.split('.')[1] !== this.ring.activeKeyId;
  }
}

export const aad = (ownerId: string, column: string) => `owner:${ownerId}|col:${column}`;
