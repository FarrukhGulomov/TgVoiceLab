/**
 * GramJS (MTProto user-account) messaging gateway.
 *
 * STATUS: implemented and type-checked; NOT LIVE VERIFIED (no Telegram network access when written). It is the single owner of
 * the assistant account session. It carries owner TEXT and VOICE NOTES only — private-call signaling/media is a separate
 * gate (see docs/research/telegram-private-calls.md) and is NOT implemented here.
 */
import { createHash } from 'node:crypto';
import bigInt from 'big-integer';
import { Api, TelegramClient } from 'telegram';
import { NewMessage, type NewMessageEvent } from 'telegram/events/index.js';
import { StringSession } from 'telegram/sessions/index.js';
import type { Logger } from '../observability/logger.js';
import type { MessagingPort, OutboundMessage, PeerResolverPort } from '../../application/ports.js';
import type { IncomingMessage, IntakeService } from '../../modules/messaging/intake.service.js';
import { convertMessage } from './convert.js';
import { RecoveryRunner, type HistoryMessage, type WatermarkStore } from './recovery.js';
import { startLane, type Lane } from '../../bootstrap/worker.js';
import { GramjsCallTransport, type CallProtocol } from './gramjs-call-transport.js';
import { classifyTelegramSendError } from '../../modules/messaging/delivery-errors.js';

export interface GramjsOptions {
  apiId: number;
  apiHash: string;
  /** The StringSession value, resolved from a secret reference. Never logged. */
  sessionSecret: string;
  log: Logger;
}

const RECOVERY_WINDOW_MS = 24 * 3600_000; // never act on instructions older than this after an outage

export class GramjsMessaging implements MessagingPort, PeerResolverPort {
  private readonly client: TelegramClient;
  private started = false;
  constructor(private readonly o: GramjsOptions) {
    this.client = new TelegramClient(new StringSession(o.sessionSecret), o.apiId, o.apiHash, { connectionRetries: 5, useWSS: false });
  }

  private selfId: string | null = null;

  /** Call signaling shares this ONE client: a second client on the same session would be kicked by Telegram. Usable after `start()`. */
  callTransport(protocol: CallProtocol): GramjsCallTransport {
    return new GramjsCallTransport(
      this.client,
      () => {
        if (!this.selfId) throw new Error('the Telegram gateway has not verified the assistant account yet');
        return this.selfId;
      },
      protocol,
    );
  }

  private recovery: RecoveryRunner<HistoryMessage & { msg: Api.Message }> | null = null;
  private recoveryLane: Lane | null = null;

  /** Live recovery status for /health/ready: `incomplete` means some owner instruction may not have been processed yet. */
  status() {
    return this.recovery ? { recovery: this.recovery.status() } : { recovery: { recovery: 'unknown' } };
  }

  /** G0-A: connect, require an authorized session, and verify the logged-in numeric id is the configured assistant account. */
  async start(a: {
    intake: IntakeService;
    accountId: string;
    expectedAssistantId: string;
    ownerTelegramId: string;
    markActive: () => Promise<void>;
    watermarks: WatermarkStore;
  }): Promise<void> {
    await this.client.connect();
    if (!(await this.client.isUserAuthorized())) throw new Error('Telegram session is not authorized; run `pnpm spike:login` locally to create a new session');
    const me = (await this.client.getMe()) as Api.User;
    if (me.id.toString() !== a.expectedAssistantId) {
      await this.client.disconnect();
      throw new Error(`logged-in account id ${me.id.toString()} does not match the configured assistant account; refusing to run`);
    }
    this.selfId = me.id.toString();
    await a.markActive();

    // Gap recovery (audit F15): GramJS does not persist update state in a StringSession, so the owner chat is re-scanned from a
    // DURABLE watermark, page by page, at start and then periodically. Intake's dedupe makes replays safe; the age window keeps stale
    // instructions from being acted on; failures are retried by the next pass and reported as `incomplete` in readiness.
    let peer: Awaited<ReturnType<TelegramClient['getInputEntity']>> | null = null;
    this.recovery = new RecoveryRunner({
      accountId: a.accountId,
      chatId: a.ownerTelegramId,
      store: a.watermarks,
      windowMs: RECOVERY_WINDOW_MS,
      clock: () => new Date(),
      source: {
        fetchPage: async (offsetId, limit) => {
          if (!peer) {
            await this.client.getDialogs({ limit: 20 }); // populates the entity cache so the owner peer resolves
            peer = await this.client.getInputEntity(bigInt(a.ownerTelegramId));
          }
          const msgs = await this.client.getMessages(peer, { limit, offsetId });
          return [...msgs].map((msg) => ({ id: msg.id, out: !!msg.out, dateMs: msg.date * 1000, msg }));
        },
      },
      handle: async (h) => {
        const m = this.convert(h.msg, a.accountId, true);
        if (m) await a.intake.handle(m);
      },
    });

    this.client.addEventHandler(
      async (ev: NewMessageEvent) => {
        try {
          const m = this.toIncoming(ev, a.accountId);
          if (m) await a.intake.handle(m);
        } catch (e) {
          // Not lost: the periodic recovery pass re-reads the chat from the watermark and retries it.
          this.o.log.error({ err: (e as Error).message }, 'inbound handling failed (the next recovery pass will retry it)');
        }
      },
      new NewMessage({ incoming: true }),
    );

    await this.recovery.runOnce().catch((e: Error) => this.o.log.warn({ err: e.message }, 'startup recovery failed (will retry)'));
    this.recoveryLane = startLane({
      name: 'telegram-recovery',
      intervalMs: 30_000,
      run: () => this.recovery!.runOnce(),
      onError: (e) => this.o.log.warn({ err: e.message }, 'recovery pass failed (will retry)'),
    });
    this.started = true;
  }

  private toIncoming(ev: NewMessageEvent, accountId: string): IncomingMessage | null {
    if (ev.message.out) return null;
    return this.convert(ev.message, accountId, ev.isPrivate ?? false);
  }

  private convert(msg: Api.Message, accountId: string, isPrivate: boolean): IncomingMessage | null {
    return convertMessage(msg, accountId, isPrivate, (m) => this.client.downloadMedia(m) as Promise<Buffer | undefined>);
  }

  /** @username or phone -> numeric user id. Only real, non-deleted, non-bot users resolve; a phone lookup adds the person to the assistant account's contacts (Telegram requires it). */
  async resolve(q: { username?: string; phone?: string }): Promise<{ telegramUserId: string; displayName: string } | null> {
    if (!this.started) throw new Error('Telegram gateway not started');
    let user: Api.User | undefined;
    if (q.username) {
      const r = await this.client.invoke(new Api.contacts.ResolveUsername({ username: q.username }));
      user = r.users.find((u): u is Api.User => u.className === 'User');
    } else if (q.phone) {
      const r = await this.client.invoke(
        new Api.contacts.ImportContacts({
          contacts: [new Api.InputPhoneContact({ clientId: bigInt(Date.now()), phone: q.phone, firstName: 'Contact', lastName: '' })],
        }),
      );
      user = r.users.find((u): u is Api.User => u.className === 'User');
    }
    if (!user || user.deleted || user.bot || user.self) return null;
    const displayName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || (user.username ? `@${user.username}` : 'Telegram user');
    return { telegramUserId: user.id.toString(), displayName };
  }

  /** Telegram `random_id` derived from the outbox event id: a redelivered send is deduplicated server-side. */
  async sendMessage(m: OutboundMessage): Promise<{ providerMessageId: string }> {
    if (!this.started) throw new Error('Telegram gateway not started');
    const peer = await this.client.getInputEntity(bigInt(m.toTelegramUserId));
    const rid = createHash('sha256').update(m.idempotencyKey).digest().subarray(0, 8).readBigInt64BE(0);
    const res = await this.client
      .invoke(new Api.messages.SendMessage({ peer, message: m.text, randomId: bigInt(rid.toString()), silent: m.silent ?? false, noWebpage: true }))
      .catch((e: unknown) => {
        throw classifyTelegramSendError(e); // deterministic rejections become PermanentDeliveryError, the rest stay retryable
      });
    const id = (res as { id?: number }).id ?? ((res as { updates?: Array<{ id?: number }> }).updates ?? []).find((u) => typeof u.id === 'number')?.id;
    return { providerMessageId: String(id ?? 'unknown') };
  }

  /** A voice note (OGG/Opus). The caller treats failure as non-fatal: the reply text was already delivered. */
  async sendVoice(to: string, ogg: Buffer, durationSeconds: number, _key: string): Promise<void> {
    if (!this.started) throw new Error('Telegram gateway not started');
    const peer = await this.client.getInputEntity(bigInt(to));
    const { CustomFile } = await import('telegram/client/uploads.js');
    await this.client.sendFile(peer, {
      file: new CustomFile('voice.ogg', ogg.length, '', ogg),
      voiceNote: true,
      attributes: [new Api.DocumentAttributeAudio({ voice: true, duration: durationSeconds })],
    });
  }

  async stop(): Promise<void> {
    await this.recoveryLane?.stop();
    await this.client.disconnect();
  }
}
