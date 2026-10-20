import { describe, expect, it } from 'vitest';
import { InboundCallService } from '../../apps/assistant/src/modules/calls/inbound-calls.js';
import { OWNER_CALLED_IN } from '../../apps/assistant/src/application/intent.js';
import { normalizeUpdate } from '../../apps/assistant/src/infrastructure/telegram/gramjs-call-transport.js';
import { loadConfig } from '../../apps/assistant/src/bootstrap/config.js';
import { createRequire } from 'node:module';

// `telegram` and `big-integer` belong to the assistant package, not to the repository root.
const req = createRequire(new URL('../../apps/assistant/package.json', import.meta.url));
const { Api } = req('telegram') as typeof import('../../apps/assistant/node_modules/telegram');
const bigInt = req('big-integer') as typeof import('../../apps/assistant/node_modules/big-integer');

const OWNER_TG = '370898987';
const call = (callerId = OWNER_TG) => ({ ref: { id: '5', accessHash: '6' }, callerId, gAHash: new Uint8Array([1]) });

function mk(
  o: { ownerRows?: Array<{ id: string; locale: string; disabled: boolean }>; allowed?: boolean; enabled?: boolean; dial?: () => Promise<unknown> } = {},
) {
  const requests: Array<{ body: Record<string, unknown>; opts: unknown }> = [];
  const registered: string[] = [];
  const released: string[] = [];
  const declined: Array<{ kind?: string }> = [];
  const dials: Array<{ ownerId: string; id: string; opts: unknown }> = [];
  const logs: string[] = [];
  const rows = o.ownerRows ?? [{ id: 'owner-1', locale: 'uz', disabled: false }];
  const svc = new InboundCallService({
    db: { query: async (_sql: string, args: unknown[]) => ({ rows: args[0] === OWNER_TG ? rows : [] }) } as never,
    authorizations: {
      createCallRequest: async (_o: string, body: Record<string, unknown>, opts: unknown) => {
        requests.push({ body, opts });
        return {} as never;
      },
    },
    orchestrator: {
      dial: async (ownerId: string, id: string, opts: unknown) => {
        dials.push({ ownerId, id, opts });
        return (o.dial ? o.dial() : { status: 'finished' }) as never;
      },
    },
    adapter: {
      registerIncoming: (id: string) => void registered.push(id),
      releaseIncoming: (id: string) => {
        released.push(id);
        return registered.includes(id) && !dials.length ? call() : undefined;
      },
      declineIncoming: async (_c, kind) => void declined.push({ kind }),
    },
    clock: { now: () => new Date('2026-10-21T10:00:00Z') } as never,
    callsEnabled: o.enabled ?? true,
    derive: () => ({ ownerCallingAllowed: o.allowed ?? true }),
    log: (l) => logs.push(l),
  });
  return { svc, requests, registered, released, declined, dials, logs };
}

describe('InboundCallService (phase 1: the owner calling in)', () => {
  it("turns the owner's ring into an owner-approved request and lets the orchestrator answer it, as an inbound call", async () => {
    const t = mk();
    await t.svc.handle(call());
    await new Promise((r) => setTimeout(r, 10));
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]!.opts).toEqual({ ownerExplicitCommand: true });
    expect(t.requests[0]!.body).toMatchObject({ recipientTelegramId: OWNER_TG, topic: 'reminder', allowedContext: [OWNER_CALLED_IN], language: 'uz' });
    expect(t.registered).toHaveLength(1);
    expect(t.dials).toEqual([{ ownerId: 'owner-1', id: t.registered[0], opts: { inbound: true } }]);
    expect(t.declined).toEqual([]);
  });

  it('declines anyone who is not the owner, without any request or conversation, and never logs who called', async () => {
    const t = mk();
    await t.svc.handle(call('555000111'));
    expect(t.declined).toEqual([{ kind: 'busy' }]);
    expect(t.requests).toEqual([]);
    expect(t.dials).toEqual([]);
    expect(t.logs.join(' ')).not.toContain('555000111');
  });

  it('declines when calls are off, the build is not verified, or the owner account is disabled', async () => {
    for (const t of [mk({ enabled: false }), mk({ allowed: false }), mk({ ownerRows: [{ id: 'o', locale: 'uz', disabled: true }] })]) {
      await t.svc.handle(call());
      expect(t.declined).toHaveLength(1);
      expect(t.dials).toEqual([]);
    }
  });

  it('hangs up a ring that the orchestrator refused before the adapter took it', async () => {
    const t = mk({ dial: async () => ({ status: 'rejected', reason: 'kill_switch_on' }) });
    await t.svc.handle(call());
    await new Promise((r) => setTimeout(r, 10));
    expect(t.released).toEqual(t.registered);
    expect(t.logs.some((l) => l.includes('kill_switch_on'))).toBe(true);
  });

  it('answers a ring storm from strangers only a few times a minute', async () => {
    const t = mk();
    for (let i = 0; i < 12; i++) await t.svc.handle(call('777'));
    expect(t.declined.length).toBe(5);
  });
});

describe('Telegram updates for incoming calls', () => {
  it('reads a ring and the final call object', () => {
    const proto = new Api.PhoneCallProtocol({ udpP2p: true, udpReflector: true, minLayer: 92, maxLayer: 92, libraryVersions: ['8.0.0'] });
    const requested = new Api.UpdatePhoneCall({
      phoneCall: new Api.PhoneCallRequested({
        id: bigInt(5),
        accessHash: bigInt(6),
        date: 1,
        adminId: bigInt(370898987),
        participantId: bigInt(8829917892),
        gAHash: Buffer.from([1, 2]),
        protocol: proto,
      }),
    });
    expect(normalizeUpdate(requested)).toMatchObject({
      kind: 'requested',
      id: '5',
      accessHash: '6',
      adminId: '370898987',
      participantId: '8829917892',
      video: false,
    });
    const final = new Api.UpdatePhoneCall({
      phoneCall: new Api.PhoneCall({
        id: bigInt(5),
        accessHash: bigInt(6),
        date: 1,
        adminId: bigInt(370898987),
        participantId: bigInt(8829917892),
        gAOrB: Buffer.from([9, 9]),
        keyFingerprint: bigInt(77),
        protocol: proto,
        connections: [],
        startDate: 2,
        p2pAllowed: true,
      }),
    });
    expect(normalizeUpdate(final)).toMatchObject({
      kind: 'confirmed',
      id: '5',
      keyFingerprint: 77n,
      p2pAllowed: true,
      versions: ['8.0.0'],
      customParameters: '{}',
    });
  });
});

describe('ANSWER_OWNER_CALLS configuration', () => {
  const base = { NODE_ENV: 'test', DATABASE_URL: 'postgres://x', TELEGRAM_API_ID: '1', TELEGRAM_API_HASH: 'abcdefgh1234' } as Record<string, string>;
  it('is off by default and needs calls enabled with the ntgcalls adapter', () => {
    expect(loadConfig(base).ANSWER_OWNER_CALLS).toBe(false);
    expect(() => loadConfig({ ...base, ANSWER_OWNER_CALLS: 'true' })).toThrow(/ANSWER_OWNER_CALLS/);
  });
});
