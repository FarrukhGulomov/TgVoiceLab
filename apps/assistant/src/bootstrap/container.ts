import type { Db } from '../infrastructure/db/db.js';
import type { DataCrypto } from '../infrastructure/crypto/data-crypto.js';
import type { Clock } from '../application/clock.js';
import type { MessagingPort } from '../application/ports.js';
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
  workerId?: string;
}

/** Composition root for the domain: services plus one worker `tick` (jobs, then outbox). */
export function buildContainer(d: ContainerDeps) {
  const tasks = new TaskService(d.crypto);
  const reminders = new ReminderService(d.db, d.crypto, d.clock);
  const jobHandlers: Record<string, JobHandler> = { 'reminder.fire': reminderFireHandler({ clock: d.clock }) };
  const outboxHandlers: Record<string, OutboxHandler> = makeOutboxHandlers({ db: d.db, crypto: d.crypto, messaging: d.messaging });
  const workerId = d.workerId ?? `worker-${process.pid}`;

  return {
    ...d,
    tasks,
    reminders,
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
