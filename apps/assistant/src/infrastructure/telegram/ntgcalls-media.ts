/**
 * ntgcalls media session for ONE private call. Encodes every runtime quirk found live (docs/research/telegram-private-calls.md §9a):
 *  F-4  runtime wants native bigint ids and plain Arrays (not Buffers) even though the .d.ts says otherwise; custom parameters must be '{}' not ''.
 *  F-5  external PCM must be 10 ms frames (48 kHz mono s16le = 960 bytes); 20 ms was audibly distorted.
 *  F-7/F-8  inbound audio only opens if PLAYBACK is attached AFTER connect, on the MICROPHONE slot, then unmute + resume,
 *           while a continuous outbound stream runs (the adapter's 10 ms silence pump provides that stream).
 * The workaround relies on undocumented third-party behaviour: the version is pinned and the live spike is its regression check.
 */
import ntgcalls from 'ntgcalls';
import type { ConfirmedCall, DhConfig, MediaSession, MediaState } from '../../modules/calls/ntgcalls/ports.js';

const { NTgCalls, MediaSource, StreamMode, StreamDevice, ConnectionState } = ntgcalls;

const SAMPLE_RATE = 48_000;
const MIC = { mediaSource: MediaSource.EXTERNAL, sampleRate: SAMPLE_RATE, channelCount: 1, input: '', keepOpen: false };
const arr = (b: Uint8Array): number[] => Array.from(b);

/** The runtime surface we use, typed as it actually behaves (the shipped declarations disagree, see F-4). */
interface Runtime {
  createP2pCall(id: bigint): Promise<void>;
  setStreamSources(id: bigint, mode: number, desc: unknown): Promise<void>;
  initExchange(id: bigint, dh: { g: number; p: number[]; random: number[] }, ga?: unknown): Promise<number[]>;
  exchangeKeys(id: bigint, gB: number[], fp: bigint): Promise<{ gAOrB: number[]; keyFingerprint: bigint | number }>;
  connectP2p(id: bigint, servers: unknown[], versions: string[], p2p: boolean, params: string): Promise<void>;
  sendSignalingData(id: bigint, data: number[]): Promise<void>;
  sendExternalFrame(id: bigint, device: number, data: number[], frame: unknown): Promise<void>;
  unmute(id: bigint): Promise<void>;
  resume(id: bigint): Promise<void>;
  stop(id: bigint): Promise<void>;
  onSignalingData(cb: (id: bigint, data: number[]) => void): void;
  onConnectionChange(cb: (id: bigint, s: { state: number }) => void): void;
  onFrames(cb: (id: bigint, mode: number, device: number, frames: Array<{ data: Uint8Array }>) => void): void;
}

let nextId = 1n;

export function createNtgcallsMedia(): MediaSession {
  const ntg = new NTgCalls() as unknown as Runtime;
  const id = nextId++; // ntgcalls identifies a P2P call by a bigint of our choosing (a Telegram user id in the spike)
  let created = false;
  return {
    async prepare(dh: DhConfig) {
      await ntg.createP2pCall(id);
      created = true;
      await ntg.setStreamSources(id, StreamMode.CAPTURE, { microphone: MIC });
      return Uint8Array.from(await ntg.initExchange(id, { g: dh.g, p: arr(dh.p), random: arr(dh.random) }, undefined));
    },
    async answer(dh: DhConfig, gAHash: Uint8Array) {
      await ntg.createP2pCall(id);
      created = true;
      await ntg.setStreamSources(id, StreamMode.CAPTURE, { microphone: MIC });
      // With the caller's g_a_hash given, ntgcalls takes the answering role and returns our g_b.
      return Uint8Array.from(await ntg.initExchange(id, { g: dh.g, p: arr(dh.p), random: arr(dh.random) }, arr(gAHash)));
    },
    async exchangeKeys(gB, fingerprint = 0n) {
      const r = await ntg.exchangeKeys(id, arr(gB), fingerprint);
      return { gA: Uint8Array.from(r.gAOrB), keyFingerprint: BigInt(r.keyFingerprint) };
    },
    async connect(c: ConfirmedCall) {
      await ntg.connectP2p(id, c.servers, c.versions, c.p2pAllowed, c.customParameters || '{}');
    },
    async attachPlayback() {
      await ntg.setStreamSources(id, StreamMode.PLAYBACK, { microphone: MIC });
      await ntg.unmute(id);
      await ntg.resume(id);
    },
    async receiveSignaling(data) {
      await ntg.sendSignalingData(id, arr(data));
    },
    onSignaling(cb) {
      ntg.onSignalingData((cid, data) => {
        if (cid === id) cb(Uint8Array.from(data));
      });
    },
    onState(cb) {
      ntg.onConnectionChange((cid, s) => {
        if (cid !== id) return;
        const m: MediaState | null =
          s.state === ConnectionState.CONNECTED
            ? 'connected'
            : s.state === ConnectionState.FAILED || s.state === ConnectionState.TIMEOUT || s.state === ConnectionState.CLOSED
              ? 'failed'
              : null;
        if (m) cb(m);
      });
    },
    onFrame(cb) {
      ntg.onFrames((cid, mode, device, frames) => {
        if (cid !== id || mode !== StreamMode.PLAYBACK || device === StreamDevice.CAMERA) return;
        for (const f of frames) cb(Uint8Array.from(f.data));
      });
    },
    async sendFrame(pcm) {
      await ntg.sendExternalFrame(id, StreamDevice.MICROPHONE, arr(pcm), { absoluteCaptureTimestampMs: BigInt(Date.now()), rotation: 0, width: 0, height: 0 });
    },
    async stop() {
      if (!created) return;
      created = false;
      await ntg.stop(id).catch(() => undefined);
    },
  };
}

export function ntgcallsProtocol() {
  return NTgCalls.getProtocol();
}
