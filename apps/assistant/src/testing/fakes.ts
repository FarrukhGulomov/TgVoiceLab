/**
 * FAKES — for tests and explicit development mode ONLY. Nothing here is evidence of a real integration, and
 * config validation refuses these in production. Names are deliberately loud.
 */
import type { MessagingPort, OutboundMessage } from '../application/ports.js';

export class FakeMessaging implements MessagingPort {
  readonly sent: Array<OutboundMessage & { providerMessageId: string }> = [];
  failNext = 0;
  private readonly byKey = new Map<string, string>();
  /** Mimics Telegram's random_id dedupe: same key -> same message, no second send. */
  async sendMessage(m: OutboundMessage) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('FAKE transient send failure');
    }
    const prior = this.byKey.get(m.idempotencyKey);
    if (prior) return { providerMessageId: prior };
    const id = `fake-${this.sent.length + 1}`;
    this.byKey.set(m.idempotencyKey, id);
    this.sent.push({ ...m, providerMessageId: id });
    return { providerMessageId: id };
  }
}
