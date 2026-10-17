import { z } from 'zod';
import { IsoInstantSchema, TelegramUserIdSchema, UuidSchema } from './ids.js';

export const CALL_END_REASONS = [
  'completed',
  'declined',
  'busy',
  'no_answer',
  'privacy_restricted',
  'consent_denied',
  'consent_withdrawn',
  'cancelled',
  'transport_error',
  'duration_limit',
  'budget_limit',
  'outcome_unknown',
] as const;
export const CallEndReasonSchema = z.enum(CALL_END_REASONS);
export type CallEndReason = z.infer<typeof CallEndReasonSchema>;

/** Reasons that must never trigger an automatic retry or redial. */
export const NON_RETRYABLE_END_REASONS: ReadonlySet<CallEndReason> = new Set([
  'declined',
  'busy',
  'privacy_restricted',
  'consent_denied',
  'consent_withdrawn',
  'cancelled',
  'duration_limit',
  'budget_limit',
  'outcome_unknown',
  'no_answer',
]);

export const CallLanguageSchema = z.enum(['uz', 'en', 'ru']);

export const ApprovedCallPlanSchema = z.object({
  callRequestId: UuidSchema,
  ownerId: UuidSchema,
  recipientTelegramId: TelegramUserIdSchema,
  /** Short slug matched against the contact's topic-scoped permission (extension to the spec interface; see docs/adr/0002). */
  topic: z.string().regex(/^[a-z0-9_.-]{1,64}$/),
  purpose: z.string().min(3).max(500),
  questions: z.array(z.string().min(1).max(300)).max(10),
  allowedContext: z.array(z.string().min(1).max(500)).max(20),
  forbiddenCommitments: z.array(z.string().min(1).max(300)).max(20),
  language: CallLanguageSchema,
  maxDurationSeconds: z.number().int().min(10).max(3600),
  authorizationId: UuidSchema,
  permissionVersion: z.number().int().min(0),
  planHash: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: IsoInstantSchema,
});
export type ApprovedCallPlan = z.infer<typeof ApprovedCallPlanSchema>;

/** The immutable, hashed portion of a plan (everything the owner approved). */
export const CallPlanBodySchema = ApprovedCallPlanSchema.omit({
  authorizationId: true,
  permissionVersion: true,
  planHash: true,
});
export type CallPlanBody = z.infer<typeof CallPlanBodySchema>;

export const PcmFrameSchema = z.object({
  callId: UuidSchema,
  sequence: z.number().int().min(0),
  monotonicTimestampUs: z.number().int().min(0),
  sampleRateHz: z.union([z.literal(8000), z.literal(16000), z.literal(24000), z.literal(48000)]),
  channels: z.literal(1),
  encoding: z.literal('s16le'),
});
export interface PcmFrame extends z.infer<typeof PcmFrameSchema> {
  samples: Uint8Array;
}

/**
 * Events a call adapter streams to the orchestrator. CONTRACT (audit F04): while a call is live the adapter MUST emit a
 * `heartbeat` at least every 30 s. A stream that shows no event for the orchestrator's idle deadline (default 90 s) is treated as
 * stalled: the orchestrator asks the provider whether the call is over and, if that is not confirmed, persists `outcome_unknown`
 * (which keeps the account occupied). A terminal `ended`/`error` event, or `reconcile() === 'ended'`, is the only proof of an end.
 */
export interface CallEvent {
  eventId: string;
  type: 'ringing' | 'connected' | 'ended' | 'error' | 'heartbeat' | 'playback_progress';
  occurredAt: string;
  providerCallId?: string;
  reason?: CallEndReason;
}

export interface CallHandle {
  callId: string;
  incomingAudio: AsyncIterable<PcmFrame>;
  events: AsyncIterable<CallEvent>;
  sendAudio(frame: PcmFrame): Promise<void>;
  flushOutput(): Promise<void>;
  end(reason: CallEndReason): Promise<void>;
}

export interface CallAdapterCapabilities {
  privateOutbound: boolean;
  privateInbound: boolean;
  pcmSend: boolean;
  pcmReceive: boolean;
  evidenceArtifact: string | null;
  buildFingerprint: string;
}

export type ReconcileResult = 'active' | 'ended' | 'unknown';

export interface TelegramCallAdapter {
  capabilities(): Promise<CallAdapterCapabilities>;
  dial(plan: ApprovedCallPlan, signal: AbortSignal): Promise<CallHandle>;
  reconcile(providerCallId: string): Promise<ReconcileResult>;
}

export const PolicyDecisionSchema = z.object({
  allowed: z.boolean(),
  reasonCode: z.string(),
  policyVersion: z.number().int(),
  authorizationId: UuidSchema.optional(),
});
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

/** Adapter error taxonomy. Adapters MUST classify: unknown outcome is not the same as rejection (spec §7). */
export class DialRejectedError extends Error {
  constructor(
    readonly reason: CallEndReason,
    message = `dial rejected: ${reason}`,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'DialRejectedError';
  }
}
/** The request may or may not have reached Telegram (timeout/crash after send). Never auto-redial. */
export class DialOutcomeUnknownError extends Error {
  constructor(
    message = 'dial outcome unknown',
    readonly providerCallId?: string,
  ) {
    super(message);
    this.name = 'DialOutcomeUnknownError';
  }
}
