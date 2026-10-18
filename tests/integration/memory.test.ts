import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../support/test-db.js';
import { seedOwner, type SeededOwner } from '../support/seed.js';
import { boot } from '../support/harness.js';
import { FakeClock } from '../../apps/assistant/src/application/clock.js';
import type { IncomingMessage } from '../../apps/assistant/src/modules/messaging/intake.service.js';
import type { Intent, InterpretContext } from '../../apps/assistant/src/application/intent.js';
import { MemoryService, OWNER_SCOPE, contactScope } from '../../apps/assistant/src/modules/memory/memory.service.js';
import { DataCrypto } from '../../apps/assistant/src/infrastructure/crypto/data-crypto.js';
import { Envelope, parseKeyRing } from '../../apps/assistant/src/infrastructure/crypto/envelope.js';
import { TEST_KEYRING } from '../support/harness.js';
import { buildContactCallInstructions } from '../../apps/assistant/src/modules/calls/conversation/contact-call-runner.js';

let t: TestDb;
let o: SeededOwner;
beforeEach(async () => {
  t = await createTestDb();
  o = await seedOwner(t.db);
});
afterEach(async () => {
  await t.drop();
});

let seq = 0;
function setup(propose?: (text: string, ctx: InterpretContext) => Promise<Intent>) {
  const clock = new FakeClock(new Date('2026-10-15T06:00:00Z'));
  const seen: InterpretContext[] = [];
  const app = boot(
    t.url,
    clock,
    undefined,
    'w',
    propose
      ? {
          textFallback: {
            propose: async (text, ctx) => {
              seen.push(ctx);
              return propose(text, ctx);
            },
          },
        }
      : {},
  );
  const say = async (text: string) => {
    const id = String(++seq);
    const msg: IncomingMessage = {
      accountId: o.accountId,
      updateKey: `msg:mm${id}`,
      providerMessageId: id,
      senderTelegramId: o.telegramUserId,
      chat: { type: 'private', id: o.telegramUserId },
      receivedAt: clock.now(),
      text,
    };
    await app.intake.handle(msg);
  };
  const last = async () => {
    await app.tick();
    return app.messaging.sent.at(-1)!.text;
  };
  return { app, clock, say, last, seen };
}

describe('owner memory (chat)', () => {
  it('remember -> list -> forget, encrypted at rest', async () => {
    const s = setup();
    await s.say('eslab qol: Farruh sutsiz qahva ichadi');
    expect(await s.last()).toContain('sutsiz qahva');
    await s.say('eslab qol: Farruh sutsiz qahva ichadi'); // same fact twice is not stored twice
    expect(await s.last()).toContain('already');
    await s.say('xotira');
    const listed = await s.last();
    expect(listed).toContain('1. Farruh sutsiz qahva ichadi');
    const raw = (await t.db.query(`SELECT value_enc FROM memories`)).rows;
    expect(raw).toHaveLength(1);
    expect(raw[0].value_enc).not.toContain('qahva');
    await s.say('unut 1');
    expect(await s.last()).toContain('Forgotten');
    expect((await t.db.query(`SELECT 1 FROM memories`)).rowCount).toBe(0);
    await s.app.close();
  });

  it("what is remembered reaches the free-form model; a named contact's notes rank first and other contacts' notes are found by topic", async () => {
    const s = setup(async () => ({ kind: 'unknown' }));
    await s.say("kontakt qo'sh Javlon 555000111");
    await s.say("kontakt qo'sh Akmal 555000222");
    const mem = new MemoryService(new DataCrypto(new Envelope(parseKeyRing(TEST_KEYRING))));
    const contacts = (await t.db.query(`SELECT id, display_name FROM contacts`)).rows;
    const id = (n: string) => contacts.find((c) => c.display_name === n).id as string;
    const now = new Date('2026-10-15T06:00:00Z');
    await mem.remember(t.db, o.ownerId, OWNER_SCOPE, "Farruh anor yaxshi ko'radi", { source: 'owner_command' }, now);
    await mem.remember(t.db, o.ownerId, contactScope(id('Javlon')), "Javlon 3 million so'm taklif qilgan", { source: 'call_report' }, now);
    await mem.remember(t.db, o.ownerId, contactScope(id('Akmal')), 'Akmal mashina sotadi', { source: 'call_report' }, now);
    await s.say('Javlon haqida nimadir tushunarsiz gap');
    const m = s.seen.at(-1)!.background!.memories!;
    expect(m.join(' | ')).toContain('Farruh anor');
    expect(m.join(' | ')).toContain('Javlon: Javlon 3 million');
    await s.say('mashina haqida nimadir tushunarsiz gap');
    expect(s.seen.at(-1)!.background!.memories![0]).toContain('Akmal'); // found by topic, no contact named
    await s.app.close();
  });

  it('removing a contact also forgets what was learnt about them', async () => {
    const s = setup();
    await s.say("kontakt qo'sh Javlon 555000111");
    const id = (await t.db.query(`SELECT id FROM contacts`)).rows[0].id as string;
    const mem = new MemoryService(new DataCrypto(new Envelope(parseKeyRing(TEST_KEYRING))));
    await mem.remember(t.db, o.ownerId, contactScope(id), "Javlon qarz so'radi", { source: 'call_report' }, new Date());
    await s.say("kontaktni o'chir Javlon");
    expect((await t.db.query(`SELECT 1 FROM memories`)).rowCount).toBe(0);
    await s.app.close();
  });
});

describe('text to a contact typed by the owner', () => {
  it('"Javlonga yoz: ..." is shown back first and sent only after "ha"', async () => {
    const s = setup();
    await s.say("kontakt qo'sh Javlon 555000111");
    await s.say("Javlonga yoz: Salom, 3 million so'mga roziman.");
    expect(await s.last()).toContain('«yes»');
    expect(s.app.messaging.sent.some((m) => m.toTelegramUserId === '555000111')).toBe(false);
    await s.say('ha');
    await s.app.tick();
    expect(s.app.messaging.sent.filter((m) => m.toTelegramUserId === '555000111').map((m) => m.text)).toEqual(["Salom, 3 million so'mga roziman."]);
    await s.app.close();
  });
});

describe('memory service', () => {
  const crypto = () => new DataCrypto(new Envelope(parseKeyRing(TEST_KEYRING)));
  it('keeps only the newest facts per scope and never returns expired or superseded ones', async () => {
    const mem = new MemoryService(crypto());
    const now = new Date('2026-10-15T06:00:00Z');
    for (let i = 0; i < 65; i++)
      await mem.remember(t.db, o.ownerId, OWNER_SCOPE, `fakt raqami ${i}`, { source: 'owner_command' }, new Date(now.getTime() + i * 1000));
    const later = new Date(now.getTime() + 100_000);
    const items = await mem.list(t.db, o.ownerId, OWNER_SCOPE, 200, later);
    expect(items).toHaveLength(60);
    expect(items[0]!.text).toBe('fakt raqami 64');
    await mem.remember(t.db, o.ownerId, OWNER_SCOPE, 'vaqtincha', { source: 'owner_command' }, now, { expiresAt: new Date(now.getTime() + 1000) });
    expect((await mem.list(t.db, o.ownerId, OWNER_SCOPE, 200, new Date(now.getTime() + 5000))).some((x) => x.text === 'vaqtincha')).toBe(false);
  });
});

describe('contact call prompt', () => {
  it("carries only that contact's remembered facts, as data", () => {
    const p = buildContactCallInstructions({
      ownerName: 'Farruh',
      contactName: 'Javlon',
      brief: 'Salom de',
      forbidden: [],
      questions: [],
      memories: ["Javlon 3 million so'm taklif qilgan"],
    });
    expect(p).toContain('3 million');
    expect(p).toContain("MA'LUMOT");
  });
});

describe('call language', () => {
  it('pins Uzbek and forbids drifting into other languages', () => {
    const p = buildContactCallInstructions({ ownerName: 'Farruh', contactName: 'Javlon', brief: 'Salom de', forbidden: [], questions: [] });
    expect(p).toContain("DOIM O'ZBEK TILIDA");
    expect(p).toContain('hind, nemis');
    expect(p).toContain('RUS yoki INGLIZ');
  });
});
