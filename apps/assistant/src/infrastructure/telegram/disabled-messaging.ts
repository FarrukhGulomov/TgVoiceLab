import type { MessagingPort, OutboundMessage } from '../../application/ports.js';

/** Honest default: no Telegram messaging configured. Sends fail (and are retried/dead-lettered by the outbox) rather than pretending. */
export class DisabledMessaging implements MessagingPort {
  async sendMessage(_m: OutboundMessage): Promise<{ providerMessageId: string }> {
    throw new Error('messaging adapter is disabled (set MESSAGING_ADAPTER)');
  }
}
