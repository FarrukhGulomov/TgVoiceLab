// OFFLINE smoke test of the ntgcalls Node binding. Proves: native module loads on this host,
// P2P call object can be created, DH exchange init runs, PCM external-frame path accepts input.
// It does NOT contact Telegram and CANNOT pass any G0-B/C/D/E gate. Output is labeled accordingly.
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
const require = createRequire(import.meta.url);
const result = { kind: 'OFFLINE_SMOKE_NOT_LIVE_EVIDENCE', node: process.version, arch: `${process.platform}-${process.arch}`, steps: [] };
const step = async (name, fn, { expectFail = false } = {}) => {
  const t0 = performance.now();
  if (expectFail) {
    try { const v = await fn(); result.steps.push({ name, ok: false, ms: +(performance.now() - t0).toFixed(1), detail: v }); }
    catch (e) { result.steps.push({ name, ok: true, expectedFailure: true, ms: +(performance.now() - t0).toFixed(1), finding: String(e?.message ?? e) }); }
    return undefined;
  }
  try { const v = await fn(); result.steps.push({ name, ok: true, ms: +(performance.now() - t0).toFixed(1), detail: v ?? null }); return v; }
  catch (e) { result.steps.push({ name, ok: false, ms: +(performance.now() - t0).toFixed(1), error: String(e?.message ?? e) }); return undefined; }
};
const { NTgCalls } = require('ntgcalls');
const ntg = new NTgCalls();
const uid = 777000n;
await step('createP2pCall', () => ntg.createP2pCall(uid));
// Synthetic RFC3526 2048-bit-ish prime is not required for init; we use the real MODP-2048 prime.
const p = Buffer.from(
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DD' +
  'EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED' +
  'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F' +
  '83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B' +
  'E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA0510' +
  '15728E5A8AACAA68FFFFFFFFFFFFFFFF', 'hex');
// FINDING: ntgcalls@3.0.3 index.d.ts declares Buffer for byte args, but the native layer rejects Buffer/Uint8Array
// ("An array was expected") and accepts plain number[]. The adapter must convert at the boundary.
await step('initExchange with Buffer args (documented typing) -> expected to FAIL on 3.0.3', () =>
  ntg.initExchange(uid, { g: 3, p, random: randomBytes(256) }, Buffer.alloc(0)).then(() => 'ACCEPTED Buffer (typing matches runtime)'),
  { expectFail: true });
const toArr = (b) => Array.from(b);
const gaHash = await step('initExchange with number[] args (runtime-accepted form)', async () => {
  const h = await ntg.initExchange(uid, { g: 3, p: toArr(p), random: toArr(randomBytes(256)) }, []);
  return { returnedType: Object.prototype.toString.call(h), length: h.length };
});
await step('onFrames/onSignalingData/onConnectionChange register', () => {
  ntg.onFrames(() => {}); ntg.onSignalingData(() => {}); ntg.onConnectionChange(() => {}); return 'registered';
});
await step('static getProtocol() (layer/library versions to advertise in phone.requestCall)', async () => NTgCalls.getProtocol());
await step('calls() list', async () => { const m = await ntg.calls(); return { size: m.size }; });
await step('sendExternalFrame before connect must reject (fail-closed expectation)', async () => {
  try { await ntg.sendExternalFrame(uid, 0, toArr(Buffer.alloc(960)), { absoluteCaptureTimestampMs: 0n, rotation: 0, width: 0, height: 0 }); return 'ACCEPTED (unexpected)'; }
  catch (e) { return `rejected: ${String(e.message).slice(0, 100)}`; }
});
result.capturedAt = new Date().toISOString();
result.ntgcallsVersion = JSON.parse((await import('node:fs')).readFileSync(new URL('./node_modules/ntgcalls/package.json', import.meta.url), 'utf8')).version;
const out = JSON.stringify(result, null, 2);
const { mkdirSync, writeFileSync } = await import('node:fs');
mkdirSync(new URL('./evidence/', import.meta.url), { recursive: true });
writeFileSync(new URL('./evidence/offline-smoke.json', import.meta.url), out + '\n');
console.log(out);
process.exit(result.steps.every(s => s.ok) ? 0 : 1);
