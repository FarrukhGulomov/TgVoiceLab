// OFFLINE smoke test of the ntgcalls Node binding. Proves only: the native module loads on this host and the documented
// call-setup API sequence is accepted locally. It does NOT contact Telegram and CANNOT pass any G0-B/C/D/E/F gate.
// Output is labeled OFFLINE_SMOKE_NOT_LIVE_EVIDENCE and written to evidence/offline-smoke.json.
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const ntgcalls = require('ntgcalls');
const { NTgCalls, MediaSource, StreamMode, StreamDevice } = ntgcalls;

const result = { kind: 'OFFLINE_SMOKE_NOT_LIVE_EVIDENCE', node: process.version, arch: `${process.platform}-${process.arch}`, steps: [], findings: [] };
const step = async (name, fn, { expectFail = false } = {}) => {
  const t0 = performance.now();
  const ms = () => +(performance.now() - t0).toFixed(1);
  try {
    const v = await fn();
    result.steps.push(
      expectFail ? { name, ok: false, ms: ms(), detail: v, note: 'expected failure did not occur' } : { name, ok: true, ms: ms(), detail: v ?? null },
    );
    return v;
  } catch (e) {
    result.steps.push(
      expectFail
        ? { name, ok: true, expectedFailure: true, ms: ms(), finding: String(e?.message ?? e) }
        : { name, ok: false, ms: ms(), error: String(e?.message ?? e) },
    );
  }
};
const toArr = (b) => Array.from(b);

// F-1/F-2: typings vs runtime (documented in docs/research/telegram-private-calls.md §5)
result.findings.push(
  'F-1: index.d.ts declares Buffer for byte arguments; the native layer accepts plain number[] and rejects Buffer/Uint8Array.',
  `F-2: index.d.ts lists enums as sequential ordinals, but runtime enums are bit flags (MediaSource.EXTERNAL=${MediaSource.EXTERNAL}, ConnectionState.CONNECTED=${ntgcalls.ConnectionState.CONNECTED}). Always use the runtime enum objects.`,
  'F-3: for an OUTGOING call initExchange must receive no ga_hash (undefined/null/omitted -> returns the 32-byte g_a_hash); an empty array is treated as the INCOMING case (returns 256-byte g_b).',
);

const ntg = new NTgCalls();
const uid = 777000n;
const MODP2048 = Buffer.from(
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B' +
    'E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AACAA68FFFFFFFFFFFFFFFF',
  'hex',
);
const dh = () => ({ g: 3, p: toArr(MODP2048), random: toArr(randomBytes(256)) });

await step('createP2pCall', () => ntg.createP2pCall(uid));
await step(
  'Buffer args are rejected by the native layer (typing/runtime mismatch F-1)',
  () => ntg.initExchange(uid, { g: 3, p: MODP2048, random: randomBytes(256) }),
  { expectFail: true },
);
await step('setStreamSources(CAPTURE, EXTERNAL microphone 48 kHz mono) — before initExchange, as py-tgcalls does', () =>
  ntg.setStreamSources(uid, StreamMode.CAPTURE, {
    microphone: { mediaSource: MediaSource.EXTERNAL, sampleRate: 48000, channelCount: 1, input: '', keepOpen: false },
  }),
);
await step('initExchange(outgoing: no ga_hash) returns a 32-byte g_a_hash', async () => {
  const h = await ntg.initExchange(uid, dh(), undefined);
  if (h.length !== 32) throw new Error(`expected 32-byte g_a_hash, got ${h.length}`);
  return { gaHashBytes: h.length };
});
await step('sendExternalFrame accepts a 20 ms 48 kHz s16le frame once an external source exists', async () => {
  await ntg.sendExternalFrame(uid, StreamDevice.MICROPHONE, toArr(Buffer.alloc(1920)), {
    absoluteCaptureTimestampMs: BigInt(Date.now()),
    rotation: 0,
    width: 0,
    height: 0,
  });
  return 'accepted (no peer connected)';
});
await step(
  'a frame sent for an unknown call is rejected (fail-closed)',
  () => ntg.sendExternalFrame(99999n, StreamDevice.MICROPHONE, toArr(Buffer.alloc(1920)), { absoluteCaptureTimestampMs: 0n, rotation: 0, width: 0, height: 0 }),
  { expectFail: true },
);
await step('event callbacks register (onFrames, onSignalingData, onConnectionChange)', () => {
  ntg.onFrames(() => {});
  ntg.onSignalingData(() => {});
  ntg.onConnectionChange(() => {});
  return 'registered';
});
await step('static getProtocol() — the descriptor advertised in phone.requestCall', async () => NTgCalls.getProtocol());
await step('calls() reflects the P2P call', async () => {
  const m = await ntg.calls();
  return { size: m.size };
});

result.capturedAt = new Date().toISOString();
result.ntgcallsVersion = JSON.parse(readFileSync(new URL('./node_modules/ntgcalls/package.json', import.meta.url), 'utf8')).version;
mkdirSync(new URL('./evidence/', import.meta.url), { recursive: true });
const out = JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
writeFileSync(new URL('./evidence/offline-smoke.json', import.meta.url), out + '\n');
console.log(out);
process.exit(result.steps.every((s) => s.ok) ? 0 : 1);
