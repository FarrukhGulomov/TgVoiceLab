/** A delivery failure that retrying cannot fix (the provider rejected the message or the recipient deterministically). */
export class PermanentDeliveryError extends Error {
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = 'PermanentDeliveryError';
  }
}

const PERMANENT = new Set([
  'MESSAGE_TOO_LONG',
  'MESSAGE_EMPTY',
  'PEER_ID_INVALID',
  'USER_IS_BLOCKED',
  'USER_DEACTIVATED',
  'INPUT_USER_DEACTIVATED',
  'CHAT_WRITE_FORBIDDEN',
  'USER_PRIVACY_RESTRICTED',
]);

/** Map a GramJS error to permanent / retryable. Flood waits, timeouts and socket errors stay retryable (returned unchanged). */
export function classifyTelegramSendError(e: unknown): unknown {
  const m = (e as { errorMessage?: unknown })?.errorMessage;
  return typeof m === 'string' && PERMANENT.has(m) ? new PermanentDeliveryError(m) : e;
}
