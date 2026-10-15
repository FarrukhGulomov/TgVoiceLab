import { randomBytes } from 'node:crypto';
import { Db } from '../../apps/assistant/src/infrastructure/db/db.js';
import { DataCrypto } from '../../apps/assistant/src/infrastructure/crypto/data-crypto.js';
import { Envelope, parseKeyRing } from '../../apps/assistant/src/infrastructure/crypto/envelope.js';
import { FakeClock } from '../../apps/assistant/src/application/clock.js';
import { FakeMessaging } from '../../apps/assistant/src/testing/fakes.js';
import { buildContainer } from '../../apps/assistant/src/bootstrap/container.js';

export const TEST_KEYRING = JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } });

/** Build a container on a (possibly pre-existing) database — a fresh Db pool simulates a process restart. */
export function boot(url: string, clock: FakeClock, messaging = new FakeMessaging(), workerId = 'w-test') {
  const db = new Db(url, undefined, 6);
  const crypto = new DataCrypto(new Envelope(parseKeyRing(TEST_KEYRING)));
  return { ...buildContainer({ db, crypto, clock, messaging, workerId }), messaging, close: () => db.close() };
}
