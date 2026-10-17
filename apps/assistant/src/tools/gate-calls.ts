/**
 * OPERATOR-RUN live gate calls for CONTACT calling (G0-D short batch, G0-E failure scenarios) through the PRODUCTION adapter.
 * The recipient is a second Telegram account that YOU control and that agreed to be called (it stands in for a contact).
 * No AI is involved: the tool dials, observes what the adapter reports, hangs up itself where the scenario says so, and writes one run
 * record per call to experiments/telegram-calls/evidence (assembled by `pnpm evidence:production`). It never redials; any exception
 * stops the run. A scenario passes only on what the adapter itself reported plus your typed confirmation that you did the action.
 *
 *   LIVE_TEST_OPT_IN=yes  LIVE_TEST_RECIPIENT_ID=<test account numeric id>  LIVE_TEST_RECIPIENT_CONSENT=yes
 *   LIVE_TEST_WINDOW_START / LIVE_TEST_WINDOW_END  (ISO instants, at most 2 h apart)
 *   GATE_SCENARIO=short_batch | decline | busy | no_answer | privacy | connectivity_loss | e_suite
 *                (e_suite = busy, no_answer, privacy, connectivity_loss one after another, with the instructions for each)
 *   GATE_HOLD_SECONDS=20 (short_batch: how long each call is held; 15..120)   GATE_PAUSE_SECONDS=20 (between batch calls)
 *   LIVE_TEST_HOST_IS_TARGET=yes (this run is on the intended deployment host)
 *
 * What you do (the tool prints the same before each call):
 *   short_batch        answer every call; the tool hangs up after GATE_HOLD_SECONDS. Ten calls in a row.
 *   decline            when it rings, REJECT the call.
 *   busy               be in another Telegram/phone call, then let it ring.
 *   no_answer          let it ring; do not touch it (up to ~100 s).
 *   privacy            first set Telegram > Settings > Privacy > Calls = Nobody (or block the assistant) on the test account.
 *   connectivity_loss  answer; after ~15 s switch the test phone to airplane mode. The tool waits up to 150 s for the ADAPTER to
 *                      report the end by itself; if it never does, the run FAILS (the tool does not force it).
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { DialRejectedError, type ApprovedCallPlan, type CallEvent } from '@tgvl/contracts';
import { NtgcallsCallAdapter } from '../modules/calls/ntgcalls/adapter.js';
import { GramjsCallTransport } from '../infrastructure/telegram/gramjs-call-transport.js';
import { createNtgcallsMedia, ntgcallsProtocol } from '../infrastructure/telegram/ntgcalls-media.js';
import { resolveSecret } from '../infrastructure/crypto/secrets.js';
import { computeBuildFingerprint } from '../modules/calls/capability-evidence.js';
import { RunRecordSchema, type RunRecord } from '../modules/calls/production-evidence.js';

const env = process.env;
const problems: string[] = [];
const need = (k: string) => {
  const v = env[k];
  if (!v) problems.push(`${k} is required`);
  return v ?? '';
};
const SCENARIOS = ['short_batch', 'decline', 'busy', 'no_answer', 'privacy', 'connectivity_loss'] as const;
type Scenario = (typeof SCENARIOS)[number];
// GATE_SCENARIO=e_suite runs the four failure scenarios still missing after decline, one after another (busy, no_answer, privacy, connectivity_loss).
const E_SUITE: Scenario[] = ['busy', 'no_answer', 'privacy', 'connectivity_loss'];
const requested = env.GATE_SCENARIO ?? '';
if (requested !== 'e_suite' && !SCENARIOS.includes(requested as Scenario))
  problems.push(`GATE_SCENARIO must be one of ${[...SCENARIOS, 'e_suite'].join(' | ')}`);
let scenario = (requested === 'e_suite' ? E_SUITE[0] : requested) as Scenario;
if (env.LIVE_TEST_OPT_IN !== 'yes') problems.push('LIVE_TEST_OPT_IN=yes (explicit opt-in to place real calls)');
if (env.LIVE_TEST_RECIPIENT_CONSENT !== 'yes') problems.push('LIVE_TEST_RECIPIENT_CONSENT=yes (the test account owner knows the calls are coming)');
const recipientId = env.LIVE_TEST_RECIPIENT_ID ?? '';
if (!/^[1-9]\d{0,18}$/.test(recipientId)) problems.push('LIVE_TEST_RECIPIENT_ID=<numeric Telegram id of the test account>');
const winStart = Date.parse(env.LIVE_TEST_WINDOW_START ?? '');
const winEnd = Date.parse(env.LIVE_TEST_WINDOW_END ?? '');
if (!Number.isFinite(winStart) || !Number.isFinite(winEnd) || winEnd <= winStart)
  problems.push('LIVE_TEST_WINDOW_START / LIVE_TEST_WINDOW_END (ISO instants) are required');
else if (winEnd - winStart > 2 * 3600_000) problems.push('the test window must be at most 2 hours');
else if (Date.now() < winStart || Date.now() > winEnd) problems.push(`now (${new Date().toISOString()}) is outside the authorized test window`);
const holdSeconds = Number(env.GATE_HOLD_SECONDS ?? '20');
const pauseSeconds = Number(env.GATE_PAUSE_SECONDS ?? '20');
if (!Number.isInteger(holdSeconds) || holdSeconds < 15 || holdSeconds > 120) problems.push('GATE_HOLD_SECONDS must be an integer between 15 and 120');
if (!Number.isInteger(pauseSeconds) || pauseSeconds < 10 || pauseSeconds > 300) problems.push('GATE_PAUSE_SECONDS must be an integer between 10 and 300');
const apiId = Number(need('TELEGRAM_API_ID'));
const apiHash = need('TELEGRAM_API_HASH');
const sessionRef = need('TELEGRAM_SESSION_SECRET_REF');
if (!process.stdin.isTTY) problems.push('an interactive terminal is required (the tool asks you to confirm what you did)');
if (problems.length) {
  console.error(`BLOCKED_EXTERNAL — the gate calls did not run (that is NOT a pass):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(2);
}

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const fingerprint = computeBuildFingerprint(root);
const client = new TelegramClient(new StringSession(resolveSecret(sessionRef)), apiId, apiHash, { connectionRetries: 3 });
await client.connect();
if (!(await client.isUserAuthorized())) {
  console.error('the stored Telegram session is not authorized; run `pnpm spike:login` first');
  process.exit(2);
}
const me = (await client.getMe()) as Api.User;
if (me.id.toString() === recipientId) {
  console.error('LIVE_TEST_RECIPIENT_ID is the assistant account itself');
  process.exit(2);
}
const adapter = new NtgcallsCallAdapter({
  transport: new GramjsCallTransport(client, () => me.id.toString(), ntgcallsProtocol()),
  media: createNtgcallsMedia,
  buildFingerprint: 'gate-calls',
});
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q: string) => (await rl.question(q)).trim().toLowerCase();

const INSTRUCTION: Record<Scenario, string> = {
  short_batch: 'ANSWER the call. The tool hangs up by itself.',
  decline: 'REJECT (decline) the call when it rings.',
  busy: 'Be IN ANOTHER CALL (Telegram or phone) before continuing, then let this one ring.',
  no_answer: 'Let it ring and do NOT touch the phone (the tool hangs up after 45 s, like the service does).',
  privacy: 'Telegram > Settings > Privacy > Calls = "Nobody" (or block the assistant) on the test account BEFORE continuing.',
  connectivity_loss: 'ANSWER the call; after ~15 s switch the test phone to AIRPLANE MODE and leave it so (up to 150 s).',
};
/** Production default is 30 s; the live run waits a little longer so a slow phone can still pick up. */
const RING_TIMEOUT_MS = 45_000;
const WAIT_MS: Record<Scenario, number> = {
  short_batch: 90_000,
  decline: 90_000,
  busy: 90_000,
  no_answer: 100_000,
  privacy: 30_000,
  connectivity_loss: 90_000,
};

interface Outcome {
  connected: boolean;
  durationSeconds: number;
  endedReason: string | null;
  dialRejected: string | null;
  dialCount: number;
  error: string | null;
  /** Who ended the call: the adapter on its own, the ring timeout (what the orchestrator does in production), or this tool's fail-safe (never counts). */
  endedBy: 'adapter' | 'ring_timeout' | 'tool_failsafe';
}

async function oneCall(batch?: { id: string; index: number; size: number }): Promise<Outcome> {
  const plan: ApprovedCallPlan = {
    callRequestId: randomUUID(),
    ownerId: randomUUID(),
    recipientTelegramId: recipientId,
    topic: 'gate_test',
    purpose: `operator-run gate call (${scenario})`,
    questions: [],
    allowedContext: [],
    forbiddenCommitments: [],
    language: 'uz',
    maxDurationSeconds: scenario === 'connectivity_loss' ? 240 : holdSeconds + 60,
    authorizationId: randomUUID(),
    permissionVersion: 0,
    planHash: 'f'.repeat(64),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  };
  const started = Date.now();
  const t = () => `[+${((Date.now() - started) / 1000).toFixed(1)}s]`;
  const out: Outcome = { connected: false, durationSeconds: 0, endedReason: null, dialRejected: null, dialCount: 1, error: null, endedBy: 'adapter' };
  let handle;
  try {
    handle = await adapter.dial(plan, new AbortController().signal);
  } catch (e) {
    if (e instanceof DialRejectedError) {
      out.dialRejected = e.reason;
      console.log(`${t()} dial rejected: ${e.reason} (${e.message})`);
    } else out.error = String((e as Error)?.message ?? e);
    return out;
  }
  console.log(`${t()} dialing${batch ? ` (${batch.index}/${batch.size})` : ''}...`);
  let connectedAt: number | null = null;
  let holdTimer: NodeJS.Timeout | undefined;
  const failSafe = setTimeout(
    () => {
      console.log(`${t()} no end reported within the scenario wait: hanging up from the tool (this run will NOT count as the adapter reporting the end)`);
      out.endedBy = 'tool_failsafe';
      void handle.end('cancelled').catch(() => undefined);
    },
    WAIT_MS[scenario] + (scenario === 'short_batch' ? holdSeconds * 1000 : 60_000),
  );
  // no_answer mirrors production: the orchestrator does not wait for Telegram's own timeout, it hangs up an unanswered ringing call after
  // its ring timeout with reason no_answer. The adapter must then PROVE the end (an `ended` event); that proof is what is recorded.
  let ringTimer: NodeJS.Timeout | undefined;
  if (scenario === 'no_answer') {
    ringTimer = setTimeout(() => {
      out.endedBy = 'ring_timeout';
      console.log(`${t()} ring timeout (${RING_TIMEOUT_MS / 1000}s): hanging up with no_answer, like the orchestrator does`);
      void handle.end('no_answer').catch(() => undefined);
    }, RING_TIMEOUT_MS);
  }
  let forced = false;
  let ended: CallEvent | null = null;
  for await (const ev of handle.events) {
    if (ev.type === 'heartbeat') continue;
    console.log(`${t()} event: ${ev.type}${ev.reason ? ` (${ev.reason})` : ''}`);
    if (ev.type === 'connected') {
      connectedAt = Date.now();
      out.connected = true;
      if (scenario === 'short_batch') holdTimer = setTimeout(() => void handle.end('completed').catch(() => undefined), holdSeconds * 1000);
    }
    if (ev.type === 'ended' || ev.type === 'error') {
      ended = ev;
      break;
    }
  }
  clearTimeout(failSafe);
  if (ringTimer) clearTimeout(ringTimer);
  if (holdTimer) clearTimeout(holdTimer);
  forced = ended?.reason === 'cancelled';
  out.durationSeconds = connectedAt === null ? 0 : Math.round((Date.now() - connectedAt) / 1000);
  out.endedReason = forced && scenario !== 'short_batch' ? null : (ended?.reason ?? null);
  return out;
}

function write(o: Outcome, extra: Partial<RunRecord>): string {
  const record = RunRecordSchema.parse({
    schemaVersion: 1,
    kind: 'live',
    producedBy: 'production-adapter',
    recordedAt: new Date().toISOString(),
    buildFingerprint: fingerprint,
    provider: 'none',
    recipientIsOwner: false,
    recipientKind: 'test_account',
    connected: o.connected,
    durationSeconds: o.durationSeconds,
    endedReason: o.endedReason,
    callFramesIn: 0,
    nonSilentFramesIn: 0,
    callFramesOut: 0,
    bridgeErrors: o.error ? 1 : 0,
    operatorHeardAiClearly: 'skipped',
    scenario,
    dialCount: o.dialCount,
    endedBy: o.endedBy,
    dialRejected: o.dialRejected,
    hostIsTarget: env.LIVE_TEST_HOST_IS_TARGET === 'yes',
    ...extra,
  });
  const dir = join(root, 'experiments/telegram-calls/evidence');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `PA-${record.recordedAt.replace(/[:.]/g, '-')}-${scenario}.local.json`);
  writeFileSync(file, JSON.stringify(record, null, 2));
  return file;
}

console.log(`assistant ${me.id.toString()} -> test account ${recipientId}; scenario ${scenario}; build ${fingerprint.slice(0, 12)}`);
let exit = 0;
if (scenario === 'short_batch') {
  const batch = { id: randomUUID(), size: 10 };
  console.log(`10 consecutive calls of ~${holdSeconds}s; the batch stops at the first call that is not clean. ${INSTRUCTION[scenario]}`);
  await ask('Press Enter when the test account is ready and you can answer 10 calls in a row... ');
  for (let i = 1; i <= batch.size; i++) {
    const o = await oneCall({ ...batch, index: i });
    const clean = o.connected && (o.endedReason === 'completed' || o.endedReason === 'duration_limit') && !o.error && !o.dialRejected;
    const file = write(o, { batchId: batch.id, batchIndex: i, batchSize: batch.size });
    console.log(`call ${i}/10: ${clean ? 'clean' : 'NOT CLEAN — batch stops'} (${o.endedReason ?? o.dialRejected ?? o.error}); record ${file}`);
    if (!clean) {
      exit = 1;
      break;
    }
    if (i < batch.size) await new Promise((r) => setTimeout(r, pauseSeconds * 1000));
  }
} else {
  const list = requested === 'e_suite' ? E_SUITE : [scenario];
  for (const [n, sc] of list.entries()) {
    scenario = sc;
    console.log(`\n[${n + 1}/${list.length}] SCENARIO ${scenario}: ${INSTRUCTION[scenario]}`);
    await ask('Press Enter when you are ready for ONE call... ');
    const o = await oneCall();
    const did = await ask(`Did you really do this: "${INSTRUCTION[scenario]}"? Type the full word yes / no : `);
    const file = write(o, { operatorConfirmedAction: did === 'yes' ? 'yes' : 'no' });
    console.log(`result: connected=${o.connected} endedReason=${o.endedReason} dialRejected=${o.dialRejected} error=${o.error}\nrun record: ${file}`);
    if (n < list.length - 1) {
      console.log('Next scenario in 20 s (no redial, Telegram needs a short pause)...');
      await new Promise((r) => setTimeout(r, 20_000));
    }
  }
  console.log('Run `pnpm evidence:production` to see whether this satisfied the scenarios (the judgement is made there, not here).');
  if (scenario === 'privacy' || requested === 'e_suite') console.log('REMINDER: set Telegram > Privacy > Calls back to "Everybody" on the test account.');
}
rl.close();
await client.disconnect();
process.exit(exit);
