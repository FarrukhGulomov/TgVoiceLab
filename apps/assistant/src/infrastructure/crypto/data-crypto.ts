import { aad, Envelope } from './envelope.js';

/** Owner-bound field encryption. The AAD ties every ciphertext to its owner and column. */
export class DataCrypto {
  constructor(private readonly envelope: Envelope) {}
  enc(ownerId: string, column: string, plaintext: string): string {
    return this.envelope.encrypt(plaintext, aad(ownerId, column));
  }
  dec(ownerId: string, column: string, ciphertext: string): string {
    return this.envelope.decrypt(ciphertext, aad(ownerId, column));
  }
  encOpt(ownerId: string, column: string, v: string | null | undefined): string | null {
    return v === null || v === undefined ? null : this.enc(ownerId, column, v);
  }
  decOpt(ownerId: string, column: string, v: string | null): string | null {
    return v === null ? null : this.dec(ownerId, column, v);
  }
}
