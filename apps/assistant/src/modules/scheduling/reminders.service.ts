import { DateTime } from 'luxon';
import type pg from 'pg';
import type { Db } from '../../infrastructure/db/db.js';
import type { DataCrypto } from '../../infrastructure/crypto/data-crypto.js';
import type { Clock } from '../../application/clock.js';
import { NotFoundError, ValidationError, VersionConflictError } from '../../application/errors.js';
import { writeAudit } from '../audit/audit.js';
import { enqueueJob } from '../jobs/jobs.js';
import { emitOutbox } from '../outbox/outbox.js';
import { nextOccurrence, type Recurrence } from './recurrence.js';
import { assertTimezone, describeInstant, resolveWallClock, type ResolvedInstant } from './wallclock.js';

export interface ReminderView {
  id: string;
  title: string;
  localWallClock: string;
  timezone: string;
  recurrence: Recurrence | null;
  nextOccurrenceAt: string | null;
  next: { date: string; time: string; tz: string } | null;
  mode: 'message' | 'call';
  kind: 'reminder' | 'briefing';
  status: 'active' | 'cancelled' | 'completed';
  version: number;
  scheduleVersion: number;
}

interface Row {
  id: string;
  title_enc: string;
  local_wall_clock: Date | string;
  timezone: string;
  recurrence: Recurrence | null;
  next_occurrence_at: Date | null;
  mode: 'message' | 'call';
  kind: 'reminder' | 'briefing';
  status: ReminderView['status'];
  version: number;
  schedule_version: number;
}
const COLS = `id, title_enc, to_char(local_wall_clock, 'YYYY-MM-DD"T"HH24:MI') AS local_wall_clock, timezone, recurrence, next_occurrence_at, mode, kind, status, version, schedule_version`;

export interface CreateReminderInput {
  title: string;
  localDateTime: string;
  timezone?: string | undefined;
  recurrence?: Recurrence | undefined;
  mode?: 'message' | 'call' | undefined;
  kind?: 'reminder' | 'briefing' | undefined;
  taskId?: string | undefined;
}

export class ReminderService {
  constructor(
    private readonly db: Db,
    private readonly crypto: DataCrypto,
    private readonly clock: Clock,
  ) {}

  private view(ownerId: string, r: Row): ReminderView {
    return {
      id: r.id,
      title: this.crypto.dec(ownerId, 'reminders.title', r.title_enc),
      localWallClock: String(r.local_wall_clock),
      timezone: r.timezone,
      recurrence: r.recurrence,
      nextOccurrenceAt: r.next_occurrence_at?.toISOString() ?? null,
      next: r.next_occurrence_at ? describeInstant(r.next_occurrence_at, r.timezone) : null,
      mode: r.mode,
      kind: r.kind,
      status: r.status,
      version: r.version,
      scheduleVersion: r.schedule_version,
    };
  }

  private async ownerTz(c: pg.PoolClient, ownerId: string): Promise<string> {
    const r = await c.query<{ timezone: string }>('SELECT timezone FROM owners WHERE id=$1', [ownerId]);
    if (!r.rows[0]) throw new NotFoundError('owner');
    return r.rows[0].timezone;
  }

  /** First instant for an anchor: the anchor itself if still in the future, else (recurring only) the next recurrence. */
  private firstInstant(local: string, tz: string, rec: Recurrence | undefined, now: Date): ResolvedInstant {
    const anchor = resolveWallClock(local, tz);
    if (anchor.utc.getTime() > now.getTime()) return anchor;
    if (!rec) {
      const d = describeInstant(anchor.utc, tz);
      throw new ValidationError('that time is in the past', { code: 'in_the_past', ...d });
    }
    return nextOccurrence(local, tz, rec, now);
  }

  private async materialize(c: pg.PoolClient, ownerId: string, reminderId: string, scheduleVersion: number, at: Date): Promise<string> {
    const occ = await c.query<{ id: string }>(
      `INSERT INTO reminder_occurrences (owner_id, reminder_id, schedule_version, scheduled_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (reminder_id, schedule_version, scheduled_at) DO NOTHING RETURNING id`,
      [ownerId, reminderId, scheduleVersion, at],
    );
    if (!occ.rows[0]) throw new VersionConflictError('reminder occurrence'); // would indicate a duplicate materialization
    const occurrenceId = occ.rows[0].id;
    await enqueueJob(c, {
      ownerId,
      kind: 'reminder.fire',
      dueAt: at,
      dedupeKey: `occ:${occurrenceId}`,
      payload: { reminderId, occurrenceId, scheduleVersion },
    });
    await c.query('UPDATE reminders SET next_occurrence_at=$2 WHERE id=$1', [reminderId, at]);
    return occurrenceId;
  }

  /** Cancel the scheduled occurrence(s) and their jobs; bumping the fencing token also fences out a worker mid-run. */
  private async cancelScheduled(c: pg.PoolClient, reminderId: string): Promise<void> {
    const occ = await c.query<{ id: string }>(`UPDATE reminder_occurrences SET state='cancelled' WHERE reminder_id=$1 AND state='scheduled' RETURNING id`, [
      reminderId,
    ]);
    if (occ.rows.length)
      await c.query(
        `UPDATE jobs SET status='cancelled', lease_owner=NULL, lease_expires_at=NULL, fencing_token=fencing_token+1
         WHERE dedupe_key = ANY($1) AND status IN ('pending','leased')`,
        [occ.rows.map((o) => `occ:${o.id}`)],
      );
  }

  async create(ownerId: string, i: CreateReminderInput, idemCtx?: pg.PoolClient): Promise<ReminderView> {
    const run = async (c: pg.PoolClient) => {
      const tz = i.timezone ?? (await this.ownerTz(c, ownerId));
      assertTimezone(tz);
      const title = i.title.trim();
      if (!title) throw new ValidationError('title is required');
      const first = this.firstInstant(i.localDateTime, tz, i.recurrence, this.clock.now());
      const ins = await c.query<Row>(
        `INSERT INTO reminders (owner_id, task_id, title_enc, local_wall_clock, timezone, recurrence, mode, kind)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${COLS}`,
        [
          ownerId,
          i.taskId ?? null,
          this.crypto.enc(ownerId, 'reminders.title', title),
          i.localDateTime.replace('T', ' '),
          tz,
          i.recurrence ? JSON.stringify(i.recurrence) : null,
          i.mode ?? 'message',
          i.kind ?? 'reminder',
        ],
      );
      const id = ins.rows[0]!.id;
      const occurrenceId = await this.materialize(c, ownerId, id, 1, first.utc);
      await emitOutbox(
        c,
        {
          ownerId,
          aggregateType: 'reminder',
          aggregateId: id,
          type: 'owner.notice',
          payload: {
            template: 'reminder_scheduled',
            reminderId: id,
            occurrenceId,
            scheduledAt: first.utc.toISOString(),
            timezone: tz,
            dstGap: first.kind === 'gap_shifted_forward',
          },
        },
        this.clock.now(),
      );
      await writeAudit(c, {
        ownerId,
        actorType: 'owner',
        action: 'reminder.create',
        resourceType: 'reminder',
        resourceId: id,
        allowed: true,
        reasonCode: 'ok',
      });
      return this.view(ownerId, (await c.query<Row>(`SELECT ${COLS} FROM reminders WHERE id=$1`, [id])).rows[0]!);
    };
    return idemCtx ? run(idemCtx) : this.db.tx(run);
  }

  async reschedule(
    ownerId: string,
    id: string,
    expectedVersion: number,
    localDateTime: string,
    timezone?: string,
    idemCtx?: pg.PoolClient,
  ): Promise<ReminderView> {
    const run = async (c: pg.PoolClient) => {
      const cur = await c.query<Row>(`SELECT ${COLS} FROM reminders WHERE id=$1 AND owner_id=$2 FOR UPDATE`, [id, ownerId]);
      if (!cur.rows[0]) throw new NotFoundError('reminder');
      const r = cur.rows[0];
      if (r.version !== expectedVersion) throw new VersionConflictError('reminder');
      if (r.status !== 'active') throw new ValidationError(`reminder is ${r.status}`);
      const tz = timezone ?? r.timezone;
      assertTimezone(tz);
      const first = this.firstInstant(localDateTime, tz, r.recurrence ?? undefined, this.clock.now());
      await this.cancelScheduled(c, id);
      const newSv = r.schedule_version + 1;
      await c.query(`UPDATE reminders SET local_wall_clock=$2, timezone=$3, schedule_version=$4, version=version+1 WHERE id=$1`, [
        id,
        localDateTime.replace('T', ' '),
        tz,
        newSv,
      ]);
      const occurrenceId = await this.materialize(c, ownerId, id, newSv, first.utc);
      await emitOutbox(
        c,
        {
          ownerId,
          aggregateType: 'reminder',
          aggregateId: id,
          type: 'owner.notice',
          payload: {
            template: 'reminder_rescheduled',
            reminderId: id,
            occurrenceId,
            scheduledAt: first.utc.toISOString(),
            timezone: tz,
            dstGap: first.kind === 'gap_shifted_forward',
          },
        },
        this.clock.now(),
      );
      await writeAudit(c, {
        ownerId,
        actorType: 'owner',
        action: 'reminder.reschedule',
        resourceType: 'reminder',
        resourceId: id,
        allowed: true,
        reasonCode: 'ok',
        metadata: { scheduleVersion: newSv },
      });
      return this.view(ownerId, (await c.query<Row>(`SELECT ${COLS} FROM reminders WHERE id=$1`, [id])).rows[0]!);
    };
    return idemCtx ? run(idemCtx) : this.db.tx(run);
  }

  async cancel(ownerId: string, id: string, expectedVersion: number, idemCtx?: pg.PoolClient): Promise<ReminderView> {
    const run = async (c: pg.PoolClient) => {
      const cur = await c.query<Row>(`SELECT ${COLS} FROM reminders WHERE id=$1 AND owner_id=$2 FOR UPDATE`, [id, ownerId]);
      if (!cur.rows[0]) throw new NotFoundError('reminder');
      if (cur.rows[0].version !== expectedVersion) throw new VersionConflictError('reminder');
      await this.cancelScheduled(c, id);
      await c.query(`UPDATE reminders SET status='cancelled', next_occurrence_at=NULL, schedule_version=schedule_version+1, version=version+1 WHERE id=$1`, [
        id,
      ]);
      await emitOutbox(
        c,
        { ownerId, aggregateType: 'reminder', aggregateId: id, type: 'owner.notice', payload: { template: 'reminder_cancelled', reminderId: id } },
        this.clock.now(),
      );
      await writeAudit(c, {
        ownerId,
        actorType: 'owner',
        action: 'reminder.cancel',
        resourceType: 'reminder',
        resourceId: id,
        allowed: true,
        reasonCode: 'ok',
      });
      return this.view(ownerId, (await c.query<Row>(`SELECT ${COLS} FROM reminders WHERE id=$1`, [id])).rows[0]!);
    };
    return idemCtx ? run(idemCtx) : this.db.tx(run);
  }

  /**
   * Daily briefing at a local wall-clock time ("HH:mm"): one active briefing per owner. Setting a new time replaces the old one in the
   * same transaction (the old occurrence and its job are cancelled and fenced, like any reschedule).
   */
  async setBriefing(ownerId: string, time: string, idemCtx?: pg.PoolClient): Promise<ReminderView> {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new ValidationError('time must be HH:mm');
    const run = async (c: pg.PoolClient) => {
      await this.cancelBriefing(ownerId, c, true);
      const tz = await this.ownerTz(c, ownerId);
      const today = DateTime.fromJSDate(this.clock.now(), { zone: tz }).toFormat('yyyy-LL-dd');
      return this.create(
        ownerId,
        { title: 'briefing', localDateTime: `${today}T${time}`, timezone: tz, recurrence: { freq: 'daily', interval: 1 }, kind: 'briefing' },
        c,
      );
    };
    return idemCtx ? run(idemCtx) : this.db.tx(run);
  }

  /** Cancel the owner's active briefing, if any. Returns whether one was cancelled. `silent` skips the owner notice (used by replace). */
  async cancelBriefing(ownerId: string, idemCtx?: pg.PoolClient, silent = false): Promise<boolean> {
    const run = async (c: pg.PoolClient) => {
      const cur = await c.query<{ id: string }>(`SELECT id FROM reminders WHERE owner_id=$1 AND kind='briefing' AND status='active' FOR UPDATE`, [ownerId]);
      const id = cur.rows[0]?.id;
      if (!id) return false;
      await this.cancelScheduled(c, id);
      await c.query(`UPDATE reminders SET status='cancelled', next_occurrence_at=NULL, schedule_version=schedule_version+1, version=version+1 WHERE id=$1`, [
        id,
      ]);
      if (!silent)
        await emitOutbox(
          c,
          { ownerId, aggregateType: 'reminder', aggregateId: id, type: 'owner.notice', payload: { template: 'reminder_cancelled', reminderId: id } },
          this.clock.now(),
        );
      await writeAudit(c, {
        ownerId,
        actorType: 'owner',
        action: 'briefing.cancel',
        resourceType: 'reminder',
        resourceId: id,
        allowed: true,
        reasonCode: 'ok',
      });
      return true;
    };
    return idemCtx ? run(idemCtx) : this.db.tx(run);
  }

  async get(ownerId: string, id: string): Promise<ReminderView> {
    const r = await this.db.query<Row>(`SELECT ${COLS} FROM reminders WHERE id=$1 AND owner_id=$2`, [id, ownerId]);
    if (!r.rows[0]) throw new NotFoundError('reminder');
    return this.view(ownerId, r.rows[0]);
  }

  async listActive(ownerId: string, limit = 50): Promise<ReminderView[]> {
    const r = await this.db.query<Row>(
      `SELECT ${COLS} FROM reminders WHERE owner_id=$1 AND status='active' AND kind='reminder' ORDER BY next_occurrence_at NULLS LAST LIMIT $2`,
      [ownerId, limit],
    );
    return r.rows.map((x) => this.view(ownerId, x));
  }
}

export { DateTime };
