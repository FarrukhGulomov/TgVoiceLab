import type { CallRef, TransportUpdate } from './guards.js';

export interface DhConfig {
  g: number;
  p: Uint8Array;
  random: Uint8Array;
}

export interface RtcServer {
  id: bigint;
  ipv4: string;
  ipv6: string;
  port: number;
  username?: string | undefined;
  password?: string | undefined;
  turn: boolean;
  stun: boolean;
  tcp: boolean;
  peerTag?: number[] | undefined;
}

export interface ConfirmedCall {
  servers: RtcServer[];
  versions: string[];
  p2pAllowed: boolean;
  customParameters: string;
}

export type DiscardKind = 'hangup' | 'disconnect' | 'missed' | 'busy';

/** Telegram side (GramJS in production). Errors from the server MUST carry `errorMessage` (GramJS RPCError does). */
export interface CallTransport {
  readonly selfId: string;
  getDhConfig(): Promise<DhConfig>;
  requestCall(args: { recipientTelegramId: string; gAHash: Uint8Array; randomId: number }): Promise<{
    ref: CallRef;
    adminId: string;
    participantId: string;
  }>;
  confirmCall(ref: CallRef, args: { gA: Uint8Array; keyFingerprint: bigint }): Promise<ConfirmedCall>;
  discardCall(ref: CallRef, args: { durationSeconds: number; kind: DiscardKind }): Promise<void>;
  sendSignaling(ref: CallRef, data: Uint8Array): Promise<void>;
  /** Subscribe to phone-call updates; returns the unsubscribe function. */
  subscribe(listener: (u: TransportUpdate) => void): () => void;
}

export type MediaState = 'connecting' | 'connected' | 'failed';

/** One media session per call (ntgcalls in production). Audio is 48 kHz mono s16le in 10 ms multiples. */
export interface MediaSession {
  /** Prepares capture and returns the DH `g_a_hash`. */
  prepare(dh: DhConfig): Promise<Uint8Array>;
  exchangeKeys(gB: Uint8Array): Promise<{ gA: Uint8Array; keyFingerprint: bigint }>;
  connect(confirmed: ConfirmedCall): Promise<void>;
  /** Attach the playback side after the connection is up (the documented-looking early attach does NOT receive audio; F-7/F-8). */
  attachPlayback(): Promise<void>;
  receiveSignaling(data: Uint8Array): Promise<void>;
  onSignaling(cb: (data: Uint8Array) => void): void;
  onState(cb: (s: MediaState) => void): void;
  onFrame(cb: (pcm: Uint8Array) => void): void;
  sendFrame(pcm: Uint8Array): Promise<void>;
  stop(): Promise<void>;
}

export type MediaSessionFactory = () => MediaSession;
