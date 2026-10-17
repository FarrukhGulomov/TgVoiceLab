import type { Db } from '../infrastructure/db/db.js';
import type { DataCrypto } from '../infrastructure/crypto/data-crypto.js';
import type { Clock } from '../application/clock.js';
import type { MessagingPort, TextInterpreterPort, TranscriptionPort } from '../application/ports.js';
import type { TelegramCallAdapter } from '@tgvl/contracts';
import { ContactService } from '../modules/contacts/contacts.service.js';
import { AuthorizationService } from '../modules/calls/authorizations.service.js';
import { ActiveCallRegistry, OperationsService } from '../modules/operations/operations.service.js';
import { CallOrchestrator, recoverOrphanedCalls, type CallSessionRunner } from '../modules/calls/orchestrator.js';
import { DisabledCallAdapter } from '../modules/calls/adapters.js';
import type { DerivedCapabilities } from '../modules/calls/capability-evidence.js';
import { IntakeService } from '../modules/messaging/intake.service.js';
import { RulesInterpreter } from '../modules/messaging/rules-interpreter.js';
import { TaskService } from '../modules/tasks/tasks.service.js';
import { ReminderService } from '../modules/scheduling/reminders.service.js';
import { reminderFireHandler } from '../modules/scheduling/reminder-jobs.js';
import { makeOutboxHandlers } from '../modules/messaging/outbox-handlers.js';
import { runRetention } from '../modules/retention/retention.js';
import { completeJob, runJobsOnce, type JobHandler } from '../modules/jobs/jobs.js';
import { dispatchOutboxOnce, type OutboxHandler } from '../modules/outbox/outbox.js';

export interface ContainerDeps {
  db: Db;
  crypto: DataCrypto;
  clock: Clock;
  messaging: MessagingPort;
  callAdapter?: TelegramCallAdapter;
  deriveCapabilities?: () => DerivedCapabilities;
  sessionRunner?: CallSessionRunner;
  callBudgetMicroUsd?: number;
  ringTimeoutMs?: number;
  interpreter?: TextInterpreterPort;
  transcription?: TranscriptionPort;
  voiceDownloadTimeoutMs?: number;
  voiceMaxConcurrentDownloads?: number;
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
    thirdPartyConsentMechanismProven: false,
    reasons: ['no evidence'],
  });
  const derive = d.deriveCapabilities ?? noCaps;
  const contacts = new ContactService();
  const authorizations = new AuthorizationService(d.db, d.clock);
  const operations = new OperationsService(d.db, d.clock, registry);
  const orchestrator = new CallOrchestrator({
    db: d.db,
    clock: d.clock,
    adapter: callAdapter,
    derive,
    registry,
    ...(d.sessionRunner ? { sessionRunner: d.sessionRunner } : {}),
    callBudgetMicroUsd: callBudget,
    ...(d.ringTimeoutMs ? { ringTimeoutMs: d.ringTimeoutMs } : {}),
  });
  const intake = new IntakeService({
    db: d.db,
    crypto: d.crypto,
    clock: d.clock,
    tasks,
    reminders,
    interpreter: d.interpreter ?? new RulesInterpreter(),
    transcription: d.transcription,
    ...(d.voiceDownloadTimeoutMs ? { voiceDownloadTimeoutMs: d.voiceDownloadTimeoutMs } : {}),
    ...(d.voiceMaxConcurrentDownloads ? { voiceMaxConcurrentDownloads: d.voiceMaxConcurrentDownloads } : {}),
  });
  const jobHandlers: Record<string, JobHandler> = {
    'reminder.fire': reminderFireHandler({ clock: d.clock }),
    // Dialing is at-most-once by construction: the orchestrator consumes the single-use authorization before the side effect,
    // so a redelivered job is refused rather than redialed. The job is settled after the orchestrator returns, whatever the outcome.
    'retention.sweep': async (job, db) => {
      await runRetention(db, d.clock.now());
      await completeJob(db, job);
    },
    'call.dial': async (job, db) => {
      const { callRequestId } = job.payload as { callRequestId: string };
      await orchestrator.dial(job.ownerId, callRequestId);
      await completeJob(db, job);
    },
  };
  const outboxHandlers: Record<string, OutboxHandler> = makeOutboxHandlers({ db: d.db, crypto: d.crypto, messaging: d.messaging });
  const workerId = d.workerId ?? `worker-${process.pid}`;

  return {
    ...d,
    tasks,
    reminders,
    intake,
    contacts,
    authorizations,
    operations,
    registry,
    orchestrator,
    derive,
    jobHandlers,
    outboxHandlers,
    /** Run once at startup, before taking work: reconcile calls orphaned by a crash. Never redials. */
    recoverCalls: () => recoverOrphanedCalls({ db: d.db, clock: d.clock, adapter: callAdapter, registry, callBudgetMicroUsd: callBudget }),
    /** One worker iteration at the clock's current time. */
    async tick() {
      const now = d.clock.now();
      const jobs = await runJobsOnce(d.db, jobHandlers, { workerId, leaseMs: 30_000, limit: 20, now });
      const outbox = await dispatchOutboxOnce(d.db, outboxHandlers, { workerId, now });
      return { jobs, outbox };
    },
  };
}
export type Container = ReturnType<typeof buildContainer>;
