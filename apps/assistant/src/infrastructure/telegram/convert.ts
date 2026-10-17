import type { Api } from 'telegram';
import type { IncomingMessage } from '../../modules/messaging/intake.service.js';

/**
 * Pure conversion of a GramJS message into the intake shape. It performs NO network I/O: voice payloads are exposed as a lazy
 * `download` that the intake service invokes only after the sender is authorized and the size / duration / format / forwarding /
 * transcription-availability checks have passed (audit F02). Unknown senders and group chats therefore cost nothing.
 */
export function convertMessage(
  msg: Api.Message,
  accountId: string,
  isPrivate: boolean,
  downloadMedia: (msg: Api.Message) => Promise<Buffer | string | undefined>,
): IncomingMessage | null {
  const sender = msg.senderId?.toString();
  const chatId = msg.chatId?.toString() ?? sender;
  if (!sender || !chatId) return null;
  const base: IncomingMessage = {
    accountId,
    updateKey: `msg:${chatId}:${msg.id}`,
    providerMessageId: String(msg.id),
    senderTelegramId: sender,
    chat: { type: isPrivate ? 'private' : 'other', id: chatId },
    receivedAt: new Date(msg.date * 1000),
    forwarded: !!msg.fwdFrom,
  };
  const doc = msg.voice as Api.Document | undefined;
  if (doc) {
    const audio = doc.attributes.find((x): x is Api.DocumentAttributeAudio => 'duration' in x);
    return {
      ...base,
      voice: {
        mime: doc.mimeType,
        durationSeconds: audio?.duration ?? 0,
        sizeBytes: Number(doc.size.toString()),
        download: async () => {
          const out = await downloadMedia(msg);
          if (!out || typeof out === 'string') throw new Error('media download returned no data');
          return new Uint8Array(out);
        },
      },
    };
  }
  return { ...base, text: msg.message };
}
