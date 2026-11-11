// G0-B / G0-C / G0-D / G0-E live private-call spike. Places a REAL call to ONE explicitly authorized, consenting test recipient.
// Refuses to run unless every authorization prerequisite is present. Mock or offline output can never satisfy these gates.
//
// Handshake order follows the py-tgcalls 3.0.0 reference (outgoing 1:1 call), re-implemented against GramJS + the ntgcalls Node binding:
//   getDhConfig -> createP2pCall -> setStreamSources(CAPTURE+PLAYBACK external) -> initExchange(no ga_hash) -> phone.requestCall
//   -> [PhoneCallAccepted] exchangeKeys -> phone.confirmCall -> connectP2p; signaling relayed both ways; frames via sendExternalFrame/onFrames.
import { createHash } from 'node:crypto';
import bigInt from 'big-integer';
import { Api, TelegramClient } from 'telegram';
import { Raw } from 'telegram/events/Raw.js';
import { StringSession } from 'telegram/sessions/index.js';
import ntgcalls from 'ntgcalls';
import { CallUpdateGate, PlacementTracker, PHASE, g0eVerdict, parseFrameMs, parseIntInRange, runBatch, windowProblem } from './call-guards.mjs';
import { ask, blocked, pins, readSecretFileIfPresent, requireTelegramCredentials, sessionPath, writeEvidence } from './lib.mjs';

const { NTgCalls, MediaSource, StreamMode, StreamDevice, ConnectionState, LogLevel, setLogLevel } = ntgcalls;
const env = process.env;
if (env.LIVE_TEST_NTG_LOG === 'debug') setLogLevel(LogLevel.DEBUG); // native ntgcalls/WebRTC logs go to the terminal; may contain IP addresses, do not paste them unfiltered

// ---- authorization gate: ALL of these are required (credentials alone are not test authorization) -------------------
const missing = [];
const cred = requireTelegramCredentials();
missing.push(...cred.missing);
if (env.LIVE_TEST_OPT_IN !== 'yes') missing.push('LIVE_TEST_OPT_IN=yes (explicit opt-in to place a real call)');
if (!/^[1-9]\d{0,18}$/.test(env.LIVE_TEST_RECIPIENT_ID ?? '')) missing.push('LIVE_TEST_RECIPIENT_ID=<numeric Telegram id of the consenting test participant>');
if (env.LIVE_TEST_RECIPIENT_CONSENT !== 'yes') missing.push('LIVE_TEST_RECIPIENT_CONSENT=yes (the participant knows a test call is coming and agreed)');
const winStart = Date.parse(env.LIVE_TEST_WINDOW_START ?? '');
const winEnd = Date.parse(env.LIVE_TEST_WINDOW_END ?? '');
const winProblem = () => windowProblem(Date.now(), winStart, winEnd);
{
  const w = winProblem();
  if (w) missing.push(w);
}
const maxSecondsR = parseIntInRange(env.LIVE_TEST_MAX_SECONDS ?? '30', 10, 600, 'LIVE_TEST_MAX_SECONDS');
const repeatR = parseIntInRange(env.LIVE_TEST_REPEAT ?? '1', 1, 10, 'LIVE_TEST_REPEAT');
const frameR = parseFrameMs(env.LIVE_TEST_FRAME_MS);
for (const r of [maxSecondsR, repeatR, frameR]) if (r.error) missing.push(r.error);
const maxSeconds = maxSecondsR.value ?? 30;
const repeat = repeatR.value ?? 1;
const scenario = env.LIVE_TEST_SCENARIO ?? 'answer'; // answer | expect_decline | expect_busy
if (!['answer', 'expect_decline', 'expect_busy'].includes(scenario)) missing.push('LIVE_TEST_SCENARIO must be answer | expect_decline | expect_busy');
// G0-E: the mapping from "declined"/"busy" to Telegram's discard class is not assumed; the operator names the exact class to expect.
const expectedReason = env.LIVE_TEST_EXPECTED_DISCARD_REASON ?? null;
if (scenario !== 'answer' && !/^PhoneCallDiscardReason[A-Za-z]+$/.test(expectedReason ?? ''))
  missing.push('LIVE_TEST_EXPECTED_DISCARD_REASON=<exact class, e.g. PhoneCallDiscardReasonBusy> is required for decline/busy scenarios');
const sess = readSecretFileIfPresent(sessionPath());
if (!sess) missing.push(`no Telegram session at ${sessionPath()} — run \`pnpm spike:login\` first (G0-A)`);
if (missing.length) blocked(missing);

const recipientId = env.LIVE_TEST_RECIPIENT_ID;
const SR = 48000;
const MIC = { mediaSource: MediaSource.EXTERNAL, sampleRate: SR, channelCount: 1, input: '', keepOpen: false };
const FRAME_MS = frameR.value; // integer multiple of 10 ms; default 10 (20 ms was audibly distorted in the first live run)
const FRAME_SAMPLES = (SR * FRAME_MS) / 1000; // 960
const toArr = (b) => Array.from(b);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = new TelegramClient(new StringSession(sess), cred.apiId, cred.apiHash, { connectionRetries: 3 });
await client.connect();
if (!(await client.isUserAuthorized())) blocked(['the stored session is no longer authorized; run `pnpm spike:login` again']);
const me = await client.getMe();
if (me.id.toString() === recipientId) blocked(['LIVE_TEST_RECIPIENT_ID is the assistant account itself']);
console.log(`Assistant account ${me.id.toString()} → test recipient ${recipientId}; ${repeat} call(s), up to ${maxSeconds}s each, scenario=${scenario}`);

// The window is re-checked before EVERY placement; an uncertain or unproven call aborts the whole batch (never redial).
const batch = await runBatch({ repeat, checkWindow: winProblem, place: runOneCall, pause: () => sleep(10_000) });
const results = batch.results;
if (batch.aborted) console.error(`BATCH ABORTED: ${batch.aborted}`);
const summary = { ...summarize(results), aborted: batch.aborted, placed: results.length, requested: repeat };
if (batch.aborted || results.length < repeat) summary.allCallsOk = false;
const out = writeEvidence(`G0-live-${scenario}-${repeat}x${maxSeconds}s.local.json`, {
  kind: 'live',
  recordedAt: new Date().toISOString(),
  pins: pins(),
  scenario,
  repeat,
  maxSeconds,
  recipientIdSha256Prefix: createHash('sha256').update(recipientId).digest('hex').slice(0, 12),
  aborted: batch.aborted,
  results,
  summary,
});
console.log(JSON.stringify(summary, null, 2));
console.log(`Evidence record: ${out}`);
await client.disconnect();
process.exit(summary.allCallsOk ? 0 : 1);

// ------------------------------------------------------------------------------------------------------------------------
async function runOneCall(index) {
  const t0 = performance.now();
  const timeline = [];
  const mark = (type, extra = {}) => timeline.push({ tMs: Math.round(performance.now() - t0), type, ...extra }); // no keys, IPs, hashes
  const stats = {
    framesSent: 0,
    framesReceived: 0,
    bytesReceived: 0,
    rmsMax: 0,
    firstReceiveMs: null,
    receivedNonSilent: 0,
    framesByKind: {},
    firstFrameBytes: null,
  };
  const uid = BigInt(recipientId);
  const ntg = new NTgCalls();
  const tracker = new PlacementTracker();
  const gate = new CallUpdateGate({ selfId: me.id.toString(), recipientId });
  const peerOf = () => {
    const t = gate.cleanupTarget(); // only the call we placed: updates for any other call can never become the target
    return t ? new Api.InputPhoneCall({ id: t.id, accessHash: t.accessHash }) : null;
  };
  let discarded = null;
  let connected = false;
  let tonePump = null;
  let connectedCap = null;
  let probe = null;
  const done = deferred();

  const inputUser = await client.getInputEntity(bigInt(recipientId));
  const dh = await client.invoke(new Api.messages.GetDhConfig({ version: 0, randomLength: 256 }));
  mark('dh_config');

  ntg.onSignalingData(async (_id, data) => {
    try {
      const target = peerOf();
      if (!target) return; // nothing bound yet: ntgcalls cannot have produced signaling for a call we did not place
      await client.invoke(new Api.phone.SendSignalingData({ peer: target, data: Buffer.from(data) }));
    } catch (e) {
      mark('signaling_send_error', { error: e.message });
    }
  });
  ntg.onConnectionChange((_id, state) => {
    mark('connection_state', { state: Object.keys(ConnectionState).find((k) => ConnectionState[k] === state.state) ?? String(state.state) });
    if (state.state === ConnectionState.CONNECTED && !connected) {
      connected = true;
      // Inbound audio only opens if PLAYBACK is attached AFTER connectP2p, on the microphone slot, then unmute+resume,
      // while a continuous outbound stream runs (found by reproducing locally; see docs/research/telegram-private-calls.md).
      (async () => {
        try {
          await ntg.setStreamSources(uid, StreamMode.PLAYBACK, { microphone: MIC });
          await ntg.unmute(uid);
          await ntg.resume(uid);
          mark('playback_attached');
        } catch (e) {
          mark('playback_attach_error', { error: String(e.message).slice(0, 120) });
        }
      })();
      tonePump = startTone(ntg, uid, stats, mark);
      if (scenario === 'answer') connectedCap = setTimeout(() => done.resolve('time_limit'), maxSeconds * 1000);
      probe = setInterval(async () => {
        try {
          mark('probe', {
            state: await ntg.getState(uid),
            mode: await ntg.getConnectionMode(uid),
            seconds: Number(await ntg.time(uid, StreamMode.PLAYBACK)),
            captureSeconds: Number(await ntg.time(uid, StreamMode.CAPTURE)),
            framesReceived: stats.framesReceived,
          });
        } catch (e) {
          mark('probe_error', { error: String(e.message).slice(0, 80) });
        }
      }, 5000);
    }
    if (state.state === ConnectionState.FAILED || state.state === ConnectionState.TIMEOUT || state.state === ConnectionState.CLOSED)
      done.resolve('connection_' + state.state);
  });
  ntg.onRemoteSourceChange((_id, src) => mark('remote_source_change', { ssrc: src.ssrc, status: src.state, device: src.device }));
  ntg.onStreamEnd((_id, type, device) => mark('stream_end', { type, device }));
  ntg.onFrames((_id, mode, device, frames) => {
    const kind = `${Object.keys(StreamMode).find((k) => StreamMode[k] === mode) ?? mode}/${Object.keys(StreamDevice).find((k) => StreamDevice[k] === device) ?? device}`;
    stats.framesByKind[kind] = (stats.framesByKind[kind] ?? 0) + frames.length;
    if (stats.firstFrameBytes === null && frames.length) stats.firstFrameBytes = Buffer.from(frames[0].data).length;
    if (device !== StreamDevice.SPEAKER && mode !== StreamMode.PLAYBACK) return;
    for (const f of frames) {
      const buf = Buffer.from(f.data);
      stats.framesReceived++;
      stats.bytesReceived += buf.length;
      if (stats.firstReceiveMs === null) stats.firstReceiveMs = Math.round(performance.now() - t0);
      const rms = rmsS16(buf);
      stats.rmsMax = Math.max(stats.rmsMax, rms);
      if (rms > 300) stats.receivedNonSilent++;
    }
  });

  const processPhoneCall = async (pc) => {
    const cls = pc.className;
    mark('phone_call_update', { cls });
    if (cls === 'PhoneCallAccepted') {
      const auth = await ntg.exchangeKeys(uid, toArr(pc.gB), 0n);
      const confirmed = await client.invoke(
        new Api.phone.ConfirmCall({
          peer: peerOf(),
          gA: Buffer.from(auth.gAOrB),
          keyFingerprint: bigInt(auth.keyFingerprint.toString()),
          protocol: protocolOf(),
        }),
      );
      const c = confirmed.phoneCall;
      const customParameters = c.customParameters?.data || '{}';
      mark('confirm_response', {
        cls: c.className,
        connections: c.connections?.length ?? 0,
        hasCustomParameters: !!c.customParameters?.data,
        p2pAllowed: !!c.p2pAllowed,
        versions: c.protocol?.libraryVersions,
      });
      await ntg.connectP2p(uid, parseServers(c.connections), c.protocol.libraryVersions, !!c.p2pAllowed, customParameters);
      mark('confirm_and_connect_submitted');
    }
    if (cls === 'PhoneCallDiscarded') {
      discarded = pc.reason?.className ?? 'unknown';
      tracker.markEnded(); // the provider told us THIS call is over
      mark('discarded', { reason: discarded });
      done.resolve('discarded');
    }
  };
  const handler = async (update) => {
    try {
      if (update instanceof Api.UpdatePhoneCallSignalingData) {
        const verdict = gate.classifySignaling(update);
        if (verdict === 'buffer') gate.buffer(update);
        else if (verdict === 'accept') await ntg.sendSignalingData(uid, toArr(update.data));
        else mark('ignored_update', { kind: 'signaling' });
        return;
      }
      if (!(update instanceof Api.UpdatePhoneCall)) return;
      const verdict = gate.classifyPhoneCall(update.phoneCall);
      if (verdict === 'buffer') gate.buffer(update.phoneCall);
      else if (verdict === 'accept') await processPhoneCall(update.phoneCall);
      else mark('ignored_update', { cls: update.phoneCall?.className });
    } catch (e) {
      mark('handler_error', { error: String(e.message).slice(0, 200) });
      done.resolve('handler_error');
    }
  };
  client.addEventHandler(handler, new Raw({ types: [Api.UpdatePhoneCall, Api.UpdatePhoneCallSignalingData] }));

  let hangup = 'not_started';
  try {
    await ntg.createP2pCall(uid);
    await ntg.setStreamSources(uid, StreamMode.CAPTURE, { microphone: MIC });
    // PLAYBACK is attached only after the P2P connection is up, on the microphone slot (see onConnectionChange).
    const gaHash = await ntg.initExchange(uid, { g: dh.g, p: toArr(dh.p), random: toArr(dh.random) }, undefined);
    const lastCheck = winProblem(); // the window may have closed during setup
    if (lastCheck) throw Object.assign(new Error(lastCheck), { windowClosed: true });
    // From the next line on, a timeout cannot prove that the call was not placed.
    tracker.markSubmitted();
    mark('request_call_submitted');
    let res;
    try {
      res = await client.invoke(
        new Api.phone.RequestCall({
          userId: inputUser,
          randomId: Math.floor(Math.random() * 0x7fffffff),
          gAHash: Buffer.from(gaHash),
          protocol: protocolOf(),
          video: false,
        }),
      );
    } catch (e) {
      tracker.markSubmitFailed(e);
      throw e;
    }
    tracker.markConfirmed();
    mark('request_call_ok');
    for (const early of gate.bind(res.phoneCall)) {
      if (early.className) await processPhoneCall(early);
      else await ntg.sendSignalingData(uid, toArr(early.data));
    }

    const timeoutMs = scenario === 'answer' ? 45_000 + maxSeconds * 1000 : 60_000;
    const cap = setTimeout(() => done.resolve('time_limit'), timeoutMs);
    const why = await done.promise;
    clearTimeout(cap);
    hangup = why;
  } catch (e) {
    mark('error', { error: String(e.message).slice(0, 200), floodWait: /FLOOD/.test(String(e.message)) });
    // Whether the call was placed is decided by the tracker, not by whether a response arrived: after a submit that did not come
    // back with a server rejection the outcome is UNKNOWN, the batch aborts, and nothing is redialed.
    hangup = tracker.phase === PHASE.NOT_SUBMITTED ? (e.windowClosed ? 'window_closed' : 'exception_before_request') : 'exception_after_submit';
    if (tracker.phase === PHASE.SUBMITTED_UNKNOWN) mark('placement_uncertain');
  } finally {
    tonePump?.stop();
    clearTimeout(connectedCap);
    clearInterval(probe);
    client.removeEventHandler(handler, new Raw({ types: [Api.UpdatePhoneCall, Api.UpdatePhoneCallSignalingData] }));
    const target = peerOf();
    if (target && !discarded) {
      try {
        await client.invoke(
          new Api.phone.DiscardCall({
            peer: target,
            duration: Math.round((performance.now() - t0) / 1000),
            reason: new Api.PhoneCallDiscardReasonHangup(),
            connectionId: bigInt(0),
          }),
        );
        mark('discard_sent');
        tracker.markEnded(); // the server accepted our hangup for our call
      } catch (e) {
        mark('discard_error', { error: String(e.message).slice(0, 120) });
        tracker.markEndUnproven(); // we cannot prove the call is over: the batch must abort
      }
    }
    try {
      await ntg.stop(uid);
    } catch {
      /* already gone */
    }
  }

  // The operator confirms what only a human can: that the other side actually heard the tone / that speech was sent.
  let heardTone = null;
  let toneQuality = null;
  if (scenario === 'answer' && connected) {
    const a = (await ask(`Call ${index}: the tone the recipient heard was — type the full word: clean (steady 440 Hz) / noisy (distorted) / none: `))
      .toLowerCase()
      .trim();
    toneQuality = ['clean', 'noisy', 'none'].includes(a) ? a : 'unanswered';
    heardTone = toneQuality === 'clean';
  }
  const g0b =
    scenario === 'answer'
      ? timeline.some((x) => x.type === 'phone_call_update' && x.cls === 'PhoneCallAccepted') &&
        connected &&
        (!discarded || discarded === 'PhoneCallDiscardReasonHangup' || hangup === 'time_limit')
      : null;
  const g0cOut = scenario === 'answer' ? connected && stats.framesSent > 0 && heardTone === true : null;
  const g0cIn = scenario === 'answer' ? stats.receivedNonSilent > 0 : null;
  const accepted = timeline.some((x) => x.type === 'phone_call_update' && x.cls === 'PhoneCallAccepted');
  const g0e =
    scenario !== 'answer' ? g0eVerdict({ scenario, discardReason: discarded, expectedReason, requestCalls: tracker.requestCalls, accepted, connected }) : null;
  mark('call_end', { hangup });
  return {
    index,
    placement: tracker.phase,
    requestCalls: tracker.requestCalls,
    ignoredUpdates: timeline.filter((x) => x.type === 'ignored_update').length,
    droppedEarlyUpdates: gate.droppedEarly,
    hangup,
    connected,
    discardReason: discarded,
    stats,
    heardTone,
    toneQuality,
    frameMs: FRAME_MS,
    gates: { 'G0-B': g0b, 'G0-C-outbound': g0cOut, 'G0-C-inbound': g0cIn, 'G0-E': g0e },
    timeline,
  };
}

function summarize(results) {
  const ok = (k) => results.every((r) => r.gates[k] === true);
  const answerRun = scenario === 'answer';
  return {
    calls: results.length,
    allCallsOk: answerRun ? ok('G0-B') && ok('G0-C-outbound') && ok('G0-C-inbound') : results.every((r) => r.gates['G0-E']?.ok),
    'G0-B': answerRun ? (ok('G0-B') ? 'PASS' : 'FAIL') : 'not exercised',
    'G0-C': answerRun ? (ok('G0-C-outbound') && ok('G0-C-inbound') ? 'PASS' : 'FAIL') : 'not exercised',
    'G0-D-candidate': answerRun
      ? `${results.filter((r) => r.gates['G0-B'] && r.gates['G0-C-outbound'] && r.gates['G0-C-inbound']).length}/${results.length} fully successful calls at ${maxSeconds}s (5-minute and 10-call criteria are judged from LIVE_TEST_MAX_SECONDS=300 / LIVE_TEST_REPEAT=10 runs)`
      : 'not exercised',
    'G0-E': answerRun
      ? 'not exercised'
      : results.every((r) => r.gates['G0-E']?.ok)
        ? 'PASS (one scenario; also run decline, busy, privacy-restricted, timeout, connectivity loss, crash)'
        : 'FAIL',
  };
}

function protocolOf() {
  const p = NTgCalls.getProtocol();
  return new Api.PhoneCallProtocol({
    udpP2p: p.udpP2p,
    udpReflector: p.udpReflector,
    minLayer: p.minLayer,
    maxLayer: p.maxLayer,
    libraryVersions: p.libraryVersions,
  });
}
function parseServers(conns) {
  return conns.map((s) =>
    s.className === 'PhoneConnectionWebrtc'
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
          peerTag: undefined,
        }
      : {
          id: BigInt(s.id.toString()),
          ipv4: s.ip,
          ipv6: s.ipv6,
          port: s.port,
          username: undefined,
          password: undefined,
          turn: true,
          stun: false,
          tcp: !!s.tcp,
          peerTag: s.peerTag ? Array.from(s.peerTag) : undefined,
        },
  );
}
function rmsS16(buf) {
  const n = Math.floor(buf.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(i * 2);
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Paced 440 Hz tone: 20 ms s16le frames on a monotonic schedule (no drift accumulation, no unbounded buffering). */
function startTone(ntg, uid, stats, mark) {
  let phase = 0;
  let stopped = false;
  let sent = 0;
  const start = process.hrtime.bigint();
  (async () => {
    while (!stopped) {
      const buf = Buffer.alloc(FRAME_SAMPLES * 2);
      for (let i = 0; i < FRAME_SAMPLES; i++) {
        buf.writeInt16LE(Math.round(Math.sin(phase) * 0.2 * 32767), i * 2);
        phase += (2 * Math.PI * 440) / SR;
      }
      try {
        await ntg.sendExternalFrame(uid, StreamDevice.MICROPHONE, toArr(buf), {
          absoluteCaptureTimestampMs: BigInt(Date.now()),
          rotation: 0,
          width: 0,
          height: 0,
        });
        stats.framesSent++;
        sent++;
      } catch (e) {
        mark('send_frame_error', { error: String(e.message).slice(0, 80) });
        return;
      }
      const dueNs = start + BigInt(sent) * BigInt(FRAME_MS) * 1_000_000n;
      const waitMs = Number((dueNs - process.hrtime.bigint()) / 1_000_000n);
      if (waitMs > 0) await sleep(waitMs);
    }
  })();
  return {
    stop() {
      stopped = true;
    },
  };
}
