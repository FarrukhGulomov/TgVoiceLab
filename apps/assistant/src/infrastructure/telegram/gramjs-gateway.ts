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
import type { MessagingPort, OutboundMessage } from '../../application/ports.js';
import type { IncomingMessage, IntakeService } from '../../modules/messaging/intake.service.js';
import { convertMessage } from './convert.js';

export interface GramjsOptions {
  apiId: number;
  apiHash: string;
  /** The StringSession value, resolved from a secret reference. Never logged. */
  sessionSecret: string;
  log: Logger;
}

const RECOVERY_WINDOW_MS = 24 * 3600_000; // never replay older instructions after an outage

export class GramjsMessaging implements MessagingPort {
  private readonly client: TelegramClient;
  private started = false;
  constructor(private readonly o: GramjsOptions) {
    this.client = new TelegramClient(new StringSession(o.sessionSecret), o.apiId, o.apiHash, { connectionRetries: 5, useWSS: false });
  }

  /** G0-A: connect, require an authorized session, and verify the logged-in numeric id is the configured assistant account. */
  async start(a: {
    intake: IntakeService;
    accountId: string;
    expectedAssistantId: string;
    ownerTelegramId: string;
    markActive: () => Promise<void>;
  }): Promise<void> {
    await this.client.connect();
    if (!(await this.client.isUserAuthorized())) throw new Error('Telegram session is not authorized; run `pnpm setup:account` locally');
    const me = (await this.client.getMe()) as Api.User;
    if (me.id.toString() !== a.expectedAssistantId) {
      await this.client.disconnect();
      throw new Error(`logged-in account id ${me.id.toString()} does not match the configured assistant account; refusing to run`);
    }
    await a.markActive();

    this.client.addEventHandler(
      async (ev: NewMessageEvent) => {
        try {
          const m = this.toIncoming(ev, a.accountId);
          if (m) await a.intake.handle(m);
        } catch (e) {
          this.o.log.error({ err: (e as Error).message }, 'inbound handling failed (will be retried on redelivery / restart recovery)');
        }
      },
      new NewMessage({ incoming: true }),
    );

    // Gap recovery: GramJS does not persist update state in a StringSession, so after a restart re-scan the owner chat.
    // Durable dedupe (inbound_updates) makes replay safe; the age window prevents acting on stale instructions.
    await this.recoverRecent(a).catch((e: Error) => this.o.log.warn({ err: e.message }, 'recent-message recovery failed'));
    this.started = true;
  }

  private async recoverRecent(a: { intake: IntakeService; accountId: string; ownerTelegramId: string }) {
    await this.client.getDialogs({ limit: 20 }); // populates the entity cache so the owner peer resolves
    const peer = await this.client.getInputEntity(bigInt(a.ownerTelegramId));
    const msgs = await this.client.getMessages(peer, { limit: 50 });
    for (const msg of [...msgs].reverse()) {
      if (msg.out || Date.now() - msg.date * 1000 > RECOVERY_WINDOW_MS) continue;
      const m = this.convert(msg, a.accountId, true);
      if (m) await a.intake.handle(m);
    }
  }

  private toIncoming(ev: NewMessageEvent, accountId: string): IncomingMessage | null {
    if (ev.message.out) return null;
    return this.convert(ev.message, accountId, ev.isPrivate ?? false);
  }

  private convert(msg: Api.Message, accountId: string, isPrivate: boolean): IncomingMessage | null {
    return convertMessage(msg, accountId, isPrivate, (m) => this.client.downloadMedia(m) as Promise<Buffer | undefined>);
  }

  /** Telegram `random_id` derived from the outbox event id: a redelivered send is deduplicated server-side. */
  async sendMessage(m: OutboundMessage): Promise<{ providerMessageId: string }> {
    if (!this.started) throw new Error('Telegram gateway not started');
    const peer = await this.client.getInputEntity(bigInt(m.toTelegramUserId));
    const rid = createHash('sha256').update(m.idempotencyKey).digest().subarray(0, 8).readBigInt64BE(0);
    const res = await this.client.invoke(
      new Api.messages.SendMessage({ peer, message: m.text, randomId: bigInt(rid.toString()), silent: m.silent ?? false, noWebpage: true }),
    );
    const id = (res as { id?: number }).id ?? ((res as { updates?: Array<{ id?: number }> }).updates ?? []).find((u) => typeof u.id === 'number')?.id;
    return { providerMessageId: String(id ?? 'unknown') };
  }

  async stop(): Promise<void> {
    await this.client.disconnect();
  }
}
