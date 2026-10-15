/** Typed ports. Real adapters live in infrastructure/; fakes live in testing/ and are never selectable silently in production. */
import type { Intent, InterpretContext } from './intent.js';

export interface OutboundMessage {
  toTelegramUserId: string;
  text: string;
  silent?: boolean;
  /** Stable across redelivery (the outbox event id). Adapters map it to Telegram `random_id` to suppress duplicates. */
  idempotencyKey: string;
}
export interface MessagingPort {
  sendMessage(m: OutboundMessage): Promise<{ providerMessageId: string }>;
}

export interface TextInterpreterPort {
  interpret(text: string, ctx: InterpretContext): Promise<Intent>;
}

export interface Transcript {
  text: string;
  /** 0..1; below the configured threshold the message must be treated as uncertain. */
  confidence: number;
  language?: string;
}
export interface TranscriptionPort {
  transcribe(audio: { bytes: Uint8Array; mime: string; durationSeconds: number }): Promise<Transcript>;
}
