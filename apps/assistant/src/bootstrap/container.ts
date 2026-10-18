import { randomUUID } from 'node:crypto';
import type { Db } from '../infrastructure/db/db.js';
import type { DataCrypto } from '../infrastructure/crypto/data-crypto.js';
import type { Clock } from '../application/clock.js';
import type { IntentFallbackPort, MessageComposerPort, MessagingPort, TextInterpreterPort, TranscriptionPort } from '../application/ports.js';
import type { TelegramCallAdapter } from '@tgvl/contracts';
import { ContactService } from '../modules/contacts/contacts.service.js';
import { AuthorizationService } from '../modules/calls/authorizations.service.js';
import { ActiveCallRegistry, OperationsService } from '../modules/operations/operations.service.js';
import { CallOrchestrator, recoverOrphanedCalls, type CallSessionRunner } from '../modules/calls/orchestrator.js';
import { DisabledCallAdapter } from '../modules/calls/adapters.js';
import type { DerivedCapabilities } from '../modules/calls/capability-evidence.js';
import { ContactCallService } from '../modules/calls/contact-calls.service.js';
import { IntakeService } from '../modules/messaging/intake.service.js';
import { ContactWatchService } from '../modules/contacts/watches.js';
import { ContactCallRecovery } from '../modules/calls/contact-call-recovery.js';
import { MemoryService } from '../modules/memory/memory.service.js';
import { RulesInterpreter } from '../modules/messaging/rules-interpreter.js';
import { DisabledInterpreter } from '../modules/messaging/disabled-interpreter.js';
import { TaskService } from '../modules/tasks/tasks.service.js';
import { ReminderService } from '../modules/scheduling/reminders.service.js';
import { reminderFireHandler } from '../modules/scheduling/reminder-jobs.js';
import { makeOutboxHandlers } from '../modules/messaging/outbox-handlers.js';
import { runRetention } from '../modules/retention/retention.js';
import { completeJob, enqueueJob, LostLeaseError, runJobsOnce, type JobHandler } from '../modules/jobs/jobs.js';
import { scheduleNextRetention } from '../modules/retention/schedule.js';
import { dispatchOutboxOnce, type OutboxHandler } from '../modules/outbox/outbox.js';

export type LaneName = 'jobs' | 'calls' | 'outbox';

export interface ContainerDeps {
  onVoiceError?: (e: Error) => void;
  /** @username / phone resolver (Telegram gateway). */
  peers?: import('../application/ports.js').PeerResolverPort;
  db: Db;
  crypto: DataCrypto;
  clock: Clock;
  messaging: MessagingPort;
  callAdapter?: TelegramCallAdapter;
  deriveCapabilities?: () => DerivedCapabilities;
  sessionRunner?: CallSessionRunner;
  callBudgetMicroUsd?: number;
  /** CALLS_ENABLED. Defaults to false (fail closed). */
  callsEnabled?: boolean;
  /** TEXT_AI_ADAPTER=disabled: no text is interpreted. Ignored when an explicit `interpreter` is supplied. */
  textAiDisabled?: boolean;
  /** Daily cap (micro-USD); the day's budget row is created lazily so budgets survive midnights without a restart. */
  dailyCapMicroUsd?: number;
  callTimeouts?: { dialMs?: number; eventIdleMs?: number; hangupMs?: number };
  ringTimeoutMs?: number;
  interpreter?: TextInterpreterPort;
  /** Free-form understanding for text the rules did not recognise (Gemini). */
  textFallback?: IntentFallbackPort;
  /** Phrases the text sent to a contact when calls could not connect. */
  composer?: MessageComposerPort;
  onFallbackError?: (e: Error) => void;
  transcription?: TranscriptionPort;
  voiceDownloadTimeoutMs?: number;
  voiceMaxConcurrentDownloads?: number;
  /** Extra job handlers (tests / future modules) with the lane that must run them. */
  extraJobHandlers?: Record<string, { lane: LaneName; handler: JobHandler }>;
  workerId?: string;
}

/** Composition root for the domain: services plus one worker `tick` (jobs, then outbox). */
export function buildContainer(d: ContainerDeps) {
  const callAdapter = d.callAdapter ?? new DisabledCallAdapter('none');
  const callBudget = d.callBudgetMicroUsd ?? 1_000_000;
  const tasks = new TaskService(d.crypto);
  const reminders = new ReminderService(d.db, d.crypto, d.clock);
  const registry = new ActiveCallRegistry();
  const noCaps = (): DerivedCapabilities => ({
    privateOutbound: false,
    privateInbound: false,
    pcmSend: false,
    pcmReceive: false,
    evidenceArtifact: null,
    buildFingerprint: 'none',
    productionCallingAllowed: false,
    ownerCallingAllowed: false,
    thirdPartyConsentMechanismProven: false,
    reasons: ['no evidence'],
  });
  const derive = d.deriveCapabilities ?? noCaps;
  const contacts = new ContactService(d.crypto);
  const memory = new MemoryService(d.crypto);
  const authorizations = new AuthorizationService(d.db, d.clock, d.crypto);
  const contactCalls = d.callsEnabled ? new ContactCallService(authorizations, d.clock) : undefined;
  const operations = new OperationsService(d.db, d.clock, registry);
  const orchestrator = new CallOrchestrator({
    db: d.db,
    crypto: d.crypto,
    clock: d.clock,
    adapter: callAdapter,
    derive,
    registry,
    ...(d.sessionRunner ? { sessionRunner: d.sessionRunner } : {}),
    callBudgetMicroUsd: callBudget,
    callsEnabled: d.callsEnabled ?? false,
    ...(d.ringTimeoutMs ? { ringTimeoutMs: d.ringTimeoutMs } : {}),
    ...(d.dailyCapMicroUsd ? { dailyCapMicroUsd: d.dailyCapMicroUsd } : {}),
    ...(d.callTimeouts ? { timeouts: d.callTimeouts } : {}),
  });
  const intake = new IntakeService({
    db: d.db,
    crypto: d.crypto,
    clock: d.clock,
    tasks,
    reminders,
    interpreter: d.interpreter ?? (d.textAiDisabled ? new DisabledInterpreter() : new RulesInterpreter()),
    transcription: d.transcription,
    ...(d.textFallback ? { fallback: d.textFallback } : {}),
    ...(d.onFallbackError ? { onFallbackError: d.onFallbackError } : {}),
    ownerCalls: operations,
    contacts,
    memory,
    watches: new ContactWatchService(),
    ...(d.onVoiceError ? { onVoiceError: d.onVoiceError } : {}),
    ...(d.peers ? { peers: d.peers } : {}),
    ...(contactCalls ? { contactCalls } : {}),
    ...(d.voiceDownloadTimeoutMs ? { voiceDownloadTimeoutMs: d.voiceDownloadTimeoutMs } : {}),
    ...(d.voiceMaxConcurrentDownloads ? { voiceMaxConcurrentDownloads: d.voiceMaxConcurrentDownloads } : {}),
  });
  const jobHandlers: Record<string, JobHandler> = {
    'reminder.fire': reminderFireHandler({
      clock: d.clock,
      requestReminderCall: async (c, a) => {
        if (!d.callsEnabled) return false;
        const o = (
          await c.query<{ telegram_user_id: string; locale: 'uz' | 'en' | 'ru'; call_opt_out: boolean }>(
            'SELECT telegram_user_id, locale, call_opt_out FROM owners WHERE id=$1',
            [a.ownerId],
          )
        ).rows[0];
        if (!o || o.call_opt_out) return false;
        const rem = (await c.query<{ title_enc: string }>('SELECT title_enc FROM reminders WHERE id=$1 AND owner_id=$2', [a.reminderId, a.ownerId])).rows[0];
        if (!rem) return false;
        const title = d.crypto.dec(a.ownerId, 'reminders.title', rem.title_enc);
        const now = d.clock.now();
        // The owner asked for this call when they set the reminder ("remind me by calling"): that is the explicit command.
        const r = await authorizations.createCallRequest(
          a.ownerId,
          {
            callRequestId: randomUUID(),
            ownerId: a.ownerId,
            recipientTelegramId: o.telegram_user_id,
            topic: 'reminder',
            purpose: `Eslatma: ${title}`.slice(0, 500),
            questions: [],
            allowedContext: [title.slice(0, 500)],
            forbiddenCommitments: [],
            language: o.locale,
            maxDurationSeconds: 300,
            expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
          },
          { ownerExplicitCommand: true },
          c,
        );
        await enqueueJob(c, {
          ownerId: a.ownerId,
          kind: 'call.dial',
          dueAt: now,
          dedupeKey: `dial:${r.callRequestId}`,
          payload: { callRequestId: r.callRequestId },
          maxAttempts: 1,
        });
        return true;
      },
    }),
    // Dialing is at-most-once by construction: the orchestrator consumes the single-use authorization before the side effect,
    // so a redelivered job is refused rather than redialed. The job is settled after the orchestrator returns, whatever the outcome.
    'retention.sweep': async (job, db) => {
      await runRetention(db, d.clock.now());
      // The successor is scheduled in the SAME transaction that completes this sweep, so maintenance renews itself (audit F09).
      await db.tx(async (c) => {
        await scheduleNextRetention(c, job.ownerId, d.clock.now());
        if (!(await completeJob(c, job))) throw new LostLeaseError(job.id);
      });
    },
    'call.dial': async (job, db) => {
      const { callRequestId } = job.payload as { callRequestId: string };
      await orchestrator.dial(job.ownerId, callRequestId);
      await completeJob(db, job);
    },
  };
  const recovery = contactCalls ? new ContactCallRecovery({ db: d.db, crypto: d.crypto, clock: d.clock, contactCalls, composer: d.composer }) : undefined;
  const outboxHandlers: Record<string, OutboxHandler> = makeOutboxHandlers({
    db: d.db,
    crypto: d.crypto,
    messaging: d.messaging,
    tasks,
    ...(recovery ? { onContactCallEnded: (a: { ownerId: string; callId: string; reason: string }) => recovery.onEnded(a.ownerId, a.callId, a.reason) } : {}),
  });
  const workerId = d.workerId ?? `worker-${process.pid}`;
  const laneOf = (kind: string): LaneName => d.extraJobHandlers?.[kind]?.lane ?? (kind === 'call.dial' ? 'calls' : 'jobs');
  for (const [kind, x] of Object.entries(d.extraJobHandlers ?? {})) jobHandlers[kind] = x.handler;
  const laneHandlers = (lane: LaneName): Record<string, JobHandler> =>
    Object.fromEntries(Object.entries(jobHandlers).filter(([kind]) => laneOf(kind) === lane));

  const clockNow = () => d.clock.now();
  const runOutboxLane = () => dispatchOutboxOnce(d.db, outboxHandlers, { workerId, now: d.clock.now(), clockNow });
  const runJobLane = (lane: Exclude<LaneName, 'outbox'>) =>
    runJobsOnce(d.db, laneHandlers(lane), {
      workerId,
      leaseMs: lane === 'calls' ? 60_000 : 30_000,
      limit: lane === 'calls' ? 1 : 20,
      now: d.clock.now(),
      clockNow,
      handlerTimeoutMs: lane === 'calls' ? 30 * 60_000 : 60_000,
    });

  return {
    ...d,
    tasks,
    reminders,
    intake,
    contacts,
    contactCalls,
    authorizations,
    operations,
    registry,
    orchestrator,
    derive,
    /** What was actually instantiated (the capability report reads these, not the raw configuration). */
    callsEnabled: d.callsEnabled ?? false,
    interpreterAdapter: d.interpreter ? 'custom' : d.textAiDisabled ? 'disabled' : 'rules',
    jobHandlers,
    outboxHandlers,
    /** Run once at startup, before taking work: reconcile calls orphaned by a crash. Never redials. */
    recoverCalls: () => recoverOrphanedCalls({ db: d.db, clock: d.clock, adapter: callAdapter, registry, callBudgetMicroUsd: callBudget }),
    /**
     * One iteration of ONE independent lane. Long call supervision (`calls`) can never delay reminders or text delivery
     * (`jobs`, `outbox`) because each lane polls on its own (audit F08).
     */
    async tickLane(lane: LaneName) {
      return lane === 'outbox' ? runOutboxLane() : runJobLane(lane);
    },
    /** All lanes once, sequentially (tests and one-shot tooling). */
    async tick() {
      const jobs = await runJobLane('jobs');
      const calls = await runJobLane('calls');
      const outbox = await runOutboxLane();
      return {
        jobs: {
          claimed: jobs.claimed + calls.claimed,
          done: jobs.done + calls.done,
          retried: jobs.retried + calls.retried,
          dead: jobs.dead + calls.dead,
          lost: jobs.lost + calls.lost,
        },
        outbox,
      };
    },
  };
}
export type Container = ReturnType<typeof buildContainer>;
