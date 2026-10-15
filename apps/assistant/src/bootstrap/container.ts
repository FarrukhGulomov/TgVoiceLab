import type { Db } from '../infrastructure/db/db.js';
import type { DataCrypto } from '../infrastructure/crypto/data-crypto.js';
import type { Clock } from '../application/clock.js';
import type { MessagingPort, TextInterpreterPort, TranscriptionPort } from '../application/ports.js';
import type { TelegramCallAdapter } from '@tgvl/contracts';
import { ContactService } from '../modules/contacts/contacts.service.js';
import { AuthorizationService } from '../modules/calls/authorizations.service.js';
import { ActiveCallRegistry, OperationsService } from '../modules/operations/operations.service.js';
import { CallOrchestrator, type CallSessionRunner } from '../modules/calls/orchestrator.js';
import { DisabledCallAdapter } from '../modules/calls/adapters.js';
import type { DerivedCapabilities } from '../modules/calls/capability-evidence.js';
import { IntakeService } from '../modules/messaging/intake.service.js';
import { RulesInterpreter } from '../modules/messaging/rules-interpreter.js';
import { TaskService } from '../modules/tasks/tasks.service.js';
import { ReminderService } from '../modules/scheduling/reminders.service.js';
import { reminderFireHandler } from '../modules/scheduling/reminder-jobs.js';
import { makeOutboxHandlers } from '../modules/messaging/outbox-handlers.js';
import { runJobsOnce, type JobHandler } from '../modules/jobs/jobs.js';
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
  workerId?: string;
}

/** Composition root for the domain: services plus one worker `tick` (jobs, then outbox). */
export function buildContainer(d: ContainerDeps) {
  const tasks = new TaskService(d.crypto);
  const reminders = new ReminderService(d.db, d.crypto, d.clock);
  const registry = new ActiveCallRegistry();
  const noCaps = (): DerivedCapabilities => ({ privateOutbound: false, privateInbound: false, pcmSend: false, pcmReceive: false, evidenceArtifact: null, buildFingerprint: 'none', productionCallingAllowed: false, thirdPartyConsentMechanismProven: false, reasons: ['no evidence'] });
  const derive = d.deriveCapabilities ?? noCaps;
  const contacts = new ContactService();
  const authorizations = new AuthorizationService(d.db, d.clock);
  const operations = new OperationsService(d.db, d.clock, registry);
  const orchestrator = new CallOrchestrator({
    db: d.db, clock: d.clock, adapter: d.callAdapter ?? new DisabledCallAdapter('none'), derive, registry,
    ...(d.sessionRunner ? { sessionRunner: d.sessionRunner } : {}), callBudgetMicroUsd: d.callBudgetMicroUsd ?? 1_000_000, ...(d.ringTimeoutMs ? { ringTimeoutMs: d.ringTimeoutMs } : {}),
  });
  const intake = new IntakeService({ db: d.db, crypto: d.crypto, clock: d.clock, tasks, reminders, interpreter: d.interpreter ?? new RulesInterpreter(), transcription: d.transcription });
  const jobHandlers: Record<string, JobHandler> = { 'reminder.fire': reminderFireHandler({ clock: d.clock }) };
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
