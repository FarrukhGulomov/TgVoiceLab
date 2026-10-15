import type { Db } from '../../infrastructure/db/db.js';
import type { Clock } from '../../application/clock.js';
import { completeJob, LostLeaseError, type ClaimedJob, type JobHandler } from '../jobs/jobs.js';
import { emitOutbox } from '../outbox/outbox.js';
import { writeAudit } from '../audit/audit.js';
import { nextOccurrence, type Recurrence } from './recurrence.js';
import { inQuietHours, type QuietHours } from './quiet-hours.js';

export type FireOutcome = 'fired' | 'fired_late' | 'call_downgraded_to_message' | 'missed_summarized' | 'stale_rejected';

export const MESSAGE_GRACE_MS = 24 * 3600_000; // spec §7: deliver overdue message reminders within 24h, once
export const CALL_GRACE_MS = 5 * 60_000; // spec §7: call reminders missed by >5 min become message notices

export interface FireDeps {
  clock: Clock;
}

interface ReminderRow {
  id: string;
  owner_id: string;
  status: string;
  schedule_version: number;
  mode: 'message' | 'call';
  recurrence: Recurrence | null;
  timezone: string;
  local: string;
}

export async function fireReminderOccurrence(db: Db, job: ClaimedJob, deps: FireDeps): Promise<FireOutcome> {
  const { reminderId, occurrenceId, scheduleVersion } = job.payload as { reminderId: string; occurrenceId: string; scheduleVersion: number };
  return db.tx(async (c) => {
    const now = deps.clock.now();
    // Lock order: reminder, then occurrence. Reschedule/cancel take the same order, so they serialize with us.
    const rem = await c.query<ReminderRow>(
      `SELECT id, owner_id, status, schedule_version, mode, recurrence, timezone, to_char(local_wall_clock, 'YYYY-MM-DD"T"HH24:MI') AS local
       FROM reminders WHERE id=$1 AND owner_id=$2 FOR UPDATE`,
      [reminderId, job.ownerId],
    );
    const occ = await c.query<{ state: string; scheduled_at: Date; schedule_version: number }>(
      `SELECT state, scheduled_at, schedule_version FROM reminder_occurrences WHERE id=$1 AND owner_id=$2 FOR UPDATE`,
      [occurrenceId, job.ownerId],
    );
    const r = rem.rows[0];
    const o = occ.rows[0];

    const stale =
      !r || !o || r.status !== 'active' || r.schedule_version !== scheduleVersion || o.schedule_version !== scheduleVersion || o.state !== 'scheduled';
    if (stale) {
      await writeAudit(c, {
        ownerId: job.ownerId,
        actorType: 'system',
        action: 'reminder.fire',
        resourceType: 'reminder',
        resourceId: reminderId,
        allowed: false,
        reasonCode: 'stale_schedule_rejected',
        metadata: { occurrenceId, jobScheduleVersion: scheduleVersion, currentScheduleVersion: r?.schedule_version ?? null },
      });
      if (o && o.state === 'scheduled') await c.query(`UPDATE reminder_occurrences SET state='skipped_stale' WHERE id=$1`, [occurrenceId]);
      if (!(await completeJob(c, job))) throw new LostLeaseError(job.id);
      return 'stale_rejected' as const;
    }

    const owner = await c.query<{ quiet_hours: QuietHours; timezone: string }>('SELECT quiet_hours, timezone FROM owners WHERE id=$1', [job.ownerId]);
    const lateMs = now.getTime() - o.scheduled_at.getTime();
    const quiet = inQuietHours(now, owner.rows[0]!.timezone, owner.rows[0]!.quiet_hours);

    let outcome: FireOutcome;
    let variant: string | null;
    if (lateMs > MESSAGE_GRACE_MS) {
      outcome = 'missed_summarized';
      variant = 'missed_summary';
      await c.query(`UPDATE reminder_occurrences SET state='summarized_missed', fired_at=$2 WHERE id=$1`, [occurrenceId, now]);
    } else {
      await c.query(`UPDATE reminder_occurrences SET state='fired', fired_at=$2 WHERE id=$1`, [occurrenceId, now]);
      if (r.mode === 'call') {
        outcome = 'call_downgraded_to_message';
        // No calling path exists until Phase 0 gates pass (spec §3.4), so a call-mode reminder always degrades to a
        // clearly labeled message. A verified dial path (Phase 3) would branch here, before this downgrade.
        variant = lateMs > CALL_GRACE_MS ? 'call_missed' : 'degraded_call';
      } else if (lateMs > CALL_GRACE_MS) {
        outcome = 'fired_late';
        variant = 'late';
      } else {
        outcome = 'fired';
        variant = 'normal';
      }
    }

    await emitOutbox(
      c,
      {
        ownerId: job.ownerId,
        aggregateType: 'reminder',
        aggregateId: reminderId,
        type: 'reminder.notify',
        payload: { reminderId, occurrenceId, variant, silent: quiet, scheduledAt: o.scheduled_at.toISOString() },
      },
      now,
    );

    // Schedule the next occurrence (recurring) or complete the reminder, in the same transaction as the firing.
    if (r.recurrence) {
      const next = nextOccurrence(r.local, r.timezone, r.recurrence, new Date(Math.max(now.getTime(), o.scheduled_at.getTime())));
      const n = await c.query<{ id: string }>(
        `INSERT INTO reminder_occurrences (owner_id, reminder_id, schedule_version, scheduled_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (reminder_id, schedule_version, scheduled_at) DO NOTHING RETURNING id`,
        [job.ownerId, reminderId, scheduleVersion, next.utc],
      );
      if (n.rows[0]) {
        await c.query(
          `INSERT INTO jobs (owner_id, kind, payload, due_at, dedupe_key) VALUES ($1,'reminder.fire',$2,$3,$4) ON CONFLICT (dedupe_key) DO NOTHING`,
          [job.ownerId, JSON.stringify({ reminderId, occurrenceId: n.rows[0].id, scheduleVersion }), next.utc, `occ:${n.rows[0].id}`],
        );
      }
      await c.query('UPDATE reminders SET next_occurrence_at=$2 WHERE id=$1', [reminderId, next.utc]);
    } else {
      await c.query(`UPDATE reminders SET status='completed', next_occurrence_at=NULL WHERE id=$1`, [reminderId]);
    }

    await writeAudit(c, {
      ownerId: job.ownerId,
      actorType: 'system',
      action: 'reminder.fire',
      resourceType: 'reminder',
      resourceId: reminderId,
      allowed: true,
      reasonCode: outcome,
      metadata: { occurrenceId, lateMs },
    });
    // Settle the job LAST and in the same tx: if we lost the lease (e.g. concurrent reschedule/cancel), everything rolls back.
    if (!(await completeJob(c, job))) throw new LostLeaseError(job.id);
    return outcome;
  });
}

export const reminderFireHandler =
  (deps: FireDeps): JobHandler =>
  async (job, db) => {
    await fireReminderOccurrence(db, job, deps);
  };
