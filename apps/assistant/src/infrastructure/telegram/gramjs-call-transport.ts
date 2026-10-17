/**
 * GramJS side of the production call adapter: MTProto phone.* requests and call updates for the ONE client that owns the assistant
 * session (it is shared with the messaging gateway; a second client on the same session would be kicked by Telegram).
 *
 * STATUS: mirrors the sequence that worked in the operator-run spike (docs/research/telegram-private-calls.md §9a). It is NOT itself
 * live verified; production calling stays off until the evidence artifact says otherwise.
 */
import bigInt from 'big-integer';
import { Api, type TelegramClient } from 'telegram';
import { Raw } from 'telegram/events/Raw.js';
import type { CallRef, TransportUpdate } from '../../modules/calls/ntgcalls/guards.js';
import type { CallTransport, ConfirmedCall, DhConfig, DiscardKind, RtcServer } from '../../modules/calls/ntgcalls/ports.js';

export interface CallProtocol {
  udpP2p: boolean;
  udpReflector: boolean;
  minLayer: number;
  maxLayer: number;
  libraryVersions: string[];
}

const bytes = (b: Buffer | Uint8Array): Uint8Array => new Uint8Array(b);
const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v));

export function toRtcServers(conns: Api.TypePhoneConnection[]): RtcServer[] {
  return conns.map((s) =>
    s instanceof Api.PhoneConnectionWebrtc
      ? {
          id: BigInt(s.id.toString()),
          ipv4: s.ip,
          ipv6: s.ipv6,
          port: s.port,
          username: s.username,
          password: s.password,
          turn: !!s.turn,
          stun: !!s.stun,
          tcp: false,
        }
      : {
          id: BigInt(s.id.toString()),
          ipv4: s.ip,
          ipv6: s.ipv6,
          port: s.port,
          turn: true,
          stun: false,
          tcp: !!s.tcp,
          peerTag: s.peerTag ? Array.from(s.peerTag) : undefined,
        },
  );
}

export function normalizeUpdate(update: unknown): TransportUpdate | null {
  if (update instanceof Api.UpdatePhoneCallSignalingData) return { kind: 'signaling', id: str(update.phoneCallId), data: bytes(update.data) };
  if (!(update instanceof Api.UpdatePhoneCall)) return null;
  const pc = update.phoneCall;
  const parties = {
    adminId: str((pc as { adminId?: unknown }).adminId) || undefined,
    participantId: str((pc as { participantId?: unknown }).participantId) || undefined,
  };
  if (pc instanceof Api.PhoneCallWaiting) return { kind: 'waiting', id: str(pc.id), delivered: pc.receiveDate !== undefined, ...parties };
  if (pc instanceof Api.PhoneCallAccepted) return { kind: 'accepted', id: str(pc.id), gB: bytes(pc.gB), ...parties };
  if (pc instanceof Api.PhoneCallDiscarded) return { kind: 'discarded', id: str(pc.id), reason: pc.reason?.className ?? 'unknown', ...parties };
  return null; // PhoneCallRequested (we never answer incoming calls), PhoneCall (the confirm response carries what we need), PhoneCallEmpty
}

const DISCARD: Record<DiscardKind, () => Api.TypePhoneCallDiscardReason> = {
  hangup: () => new Api.PhoneCallDiscardReasonHangup(),
  disconnect: () => new Api.PhoneCallDiscardReasonDisconnect(),
  missed: () => new Api.PhoneCallDiscardReasonMissed(),
  busy: () => new Api.PhoneCallDiscardReasonBusy(),
};

export class GramjsCallTransport implements CallTransport {
  constructor(
    private readonly client: TelegramClient,
    /** Resolved lazily: the logged-in id is only known after the gateway has connected and verified the account. */
    private readonly resolveSelfId: () => string,
    private readonly protocol: CallProtocol,
  ) {}

  get selfId(): string {
    return this.resolveSelfId();
  }

  private protocolOf(): Api.PhoneCallProtocol {
    return new Api.PhoneCallProtocol({ ...this.protocol });
  }
  private peer(ref: CallRef): Api.InputPhoneCall {
    return new Api.InputPhoneCall({ id: bigInt(ref.id), accessHash: bigInt(ref.accessHash) });
  }

  async getDhConfig(): Promise<DhConfig> {
    const dh = (await this.client.invoke(new Api.messages.GetDhConfig({ version: 0, randomLength: 256 }))) as Api.messages.DhConfig;
    return { g: dh.g, p: bytes(dh.p), random: bytes(dh.random) };
  }

  async requestCall(a: { recipientTelegramId: string; gAHash: Uint8Array; randomId: number }) {
    const userId = await this.client.getInputEntity(bigInt(a.recipientTelegramId));
    const res = await this.client.invoke(
      new Api.phone.RequestCall({ userId, randomId: a.randomId, gAHash: Buffer.from(a.gAHash), protocol: this.protocolOf(), video: false }),
    );
    const pc = res.phoneCall as Api.PhoneCallWaiting;
    return { ref: { id: str(pc.id), accessHash: str(pc.accessHash) }, adminId: str(pc.adminId), participantId: str(pc.participantId) };
  }

  async confirmCall(ref: CallRef, a: { gA: Uint8Array; keyFingerprint: bigint }): Promise<ConfirmedCall> {
    const res = await this.client.invoke(
      new Api.phone.ConfirmCall({
        peer: this.peer(ref),
        gA: Buffer.from(a.gA),
        keyFingerprint: bigInt(a.keyFingerprint.toString()),
        protocol: this.protocolOf(),
      }),
    );
    const c = res.phoneCall as Api.PhoneCall;
    return {
      servers: toRtcServers(c.connections),
      versions: c.protocol.libraryVersions ?? [],
      p2pAllowed: !!c.p2pAllowed,
      customParameters: c.customParameters?.data || '{}', // an empty string fails ntgcalls' JSON parsing (F-4)
    };
  }

  async discardCall(ref: CallRef, a: { durationSeconds: number; kind: DiscardKind }): Promise<void> {
    await this.client.invoke(
      new Api.phone.DiscardCall({ peer: this.peer(ref), duration: a.durationSeconds, reason: DISCARD[a.kind](), connectionId: bigInt(0) }),
    );
  }

  async sendSignaling(ref: CallRef, data: Uint8Array): Promise<void> {
    await this.client.invoke(new Api.phone.SendSignalingData({ peer: this.peer(ref), data: Buffer.from(data) }));
  }

  subscribe(listener: (u: TransportUpdate) => void): () => void {
    const filter = new Raw({ types: [Api.UpdatePhoneCall, Api.UpdatePhoneCallSignalingData] });
    const handler = (update: unknown) => {
      const u = normalizeUpdate(update);
      if (u) listener(u);
    };
    this.client.addEventHandler(handler, filter);
    return () => this.client.removeEventHandler(handler, filter);
  }
}
