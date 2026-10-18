/** Typed ports. Real adapters live in infrastructure/; fakes live in testing/ and are never selectable silently in production. */
import type { ClarificationDraft, Intent, InterpretContext } from './intent.js';

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
  /** Try to finish a pending clarification with the owner's next message. `null` = this message does not answer it. */
  completeDraft?(text: string, draft: ClarificationDraft, ctx: InterpretContext): Promise<Intent | null>;
}

/**
 * Free-form understanding for text the rules did not recognise. It only PROPOSES an intent from the same closed union; the
 * application validates and executes it (a proposed call additionally needs the owner's explicit confirmation).
 */
export interface IntentFallbackPort {
  propose(text: string, ctx: InterpretContext): Promise<Intent>;
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

/** Resolves a Telegram @username or phone number to a numeric user id, so the owner never has to look up ids. Network-backed. */
export interface PeerResolverPort {
  resolve(q: { username?: string; phone?: string }): Promise<{ telegramUserId: string; displayName: string } | null>;
}
