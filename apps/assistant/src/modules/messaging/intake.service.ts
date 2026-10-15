import { DateTime } from 'luxon';
import type pg from 'pg';
import type { Db } from '../../infrastructure/db/db.js';
import type { DataCrypto } from '../../infrastructure/crypto/data-crypto.js';
import type { Clock } from '../../application/clock.js';
import type { Intent, LocalDateTime, TaskRef } from '../../application/intent.js';
import type { TextInterpreterPort, TranscriptionPort } from '../../application/ports.js';
import { DomainError } from '../../application/errors.js';
import { authenticateOwnerMessage, type Principal } from '../identity/identity.js';
import { emitOutbox } from '../outbox/outbox.js';
import { writeAudit } from '../audit/audit.js';
import type { TaskService, Task } from '../tasks/tasks.service.js';
import type { ReminderService } from '../scheduling/reminders.service.js';
import { describeInstant, resolveWallClock } from '../scheduling/wallclock.js';
import { t, type Locale, type MessageKey } from './i18n.js';

export const VOICE_MAX_SECONDS = 300; // spec §9.3: five minutes
export const VOICE_MAX_BYTES = 20 * 1024 * 1024; // spec §9.3: 20 MiB
export const TRANSCRIPT_MIN_CONFIDENCE = 0.7;
const SNAPSHOT_MAX_AGE_MS = 24 * 3600_000;
const MESSAGE_RETENTION_MS = 30 * 24 * 3600_000; // spec §9.2 default; configurable before launch

export interface IncomingMessage {
  accountId: string;
  /** Stable per Telegram update; the durable dedupe key. */
  updateKey: string;
  providerMessageId: string;
  senderTelegramId: string;
  chat: { type: string; id: string };
  receivedAt: Date;
  text?: string;
  voice?: { bytes: Uint8Array; mime: string; durationSeconds: number };
  forwarded?: boolean;
}

export type IntakeResult =
  | { status: 'duplicate' }
  | { status: 'denied'; reason: string }
  | { status: 'handled'; intent: Intent['kind'] | 'voice_rejected' | 'forwarded_ignored' | 'voice_uncertain' };

export class IntakeService {
  constructor(
    private readonly d: {
      db: Db; crypto: DataCrypto; clock: Clock; tasks: TaskService; reminders: ReminderService;
      interpreter: TextInterpreterPort; transcription?: TranscriptionPort | undefined;
    },
  ) {}

  async handle(m: IncomingMessage): Promise<IntakeResult> {
    const { db, clock } = this.d;
    // Cheap durable duplicate check first so a redelivered voice note is not transcribed (and billed) again.
    const seen = await db.query('SELECT 1 FROM inbound_updates WHERE account_id=$1 AND update_key=$2', [m.accountId, m.updateKey]);
    if (seen.rowCount) return { status: 'duplicate' };

    const auth = await authenticateOwnerMessage(db, m, clock.now());
    if (!auth.ok) return { status: 'denied', reason: auth.reason }; // silent: no reply to strangers, no state change
    const p = auth.principal;

    let text = m.text ?? '';
    let confidence: number | null = null;
    let rejection: { key: MessageKey; vars?: Record<string, string | number> } | null = null;
    let outcome: Extract<IntakeResult, { status: 'handled' }>['intent'] | null = null;

    if (m.forwarded) {
      // Forwarded content is data from a third party, never an instruction (spec §9.1).
      rejection = { key: 'forwarded_not_instruction' };
      outcome = 'forwarded_ignored';
    } else if (m.voice) {
      if (m.voice.durationSeconds > VOICE_MAX_SECONDS) rejection = { key: 'voice_too_long', vars: { limit: VOICE_MAX_SECONDS / 60 } };
      else if (m.voice.bytes.byteLength > VOICE_MAX_BYTES) rejection = { key: 'voice_too_large' };
      else if (!this.d.transcription) rejection = { key: 'transcription_unavailable' };
      else {
        try {
          const tr = await this.d.transcription.transcribe(m.voice);
          text = tr.text;
          confidence = tr.confidence;
          if (tr.confidence < TRANSCRIPT_MIN_CONFIDENCE) {
            rejection = { key: 'voice_uncertain', vars: { text: tr.text.slice(0, 200) } };
            outcome = 'voice_uncertain';
          }
        } catch {
          rejection = { key: 'voice_failed' };
        }
      }
      if (rejection && !outcome) outcome = 'voice_rejected';
    }

    const intent: Intent | null = rejection ? null : await this.d.interpreter.interpret(text, { receivedAt: m.receivedAt, timezone: p.timezone, locale: p.locale });

    return db.tx(async (c) => {
      // Durable dedupe + effect in ONE transaction: a crash before commit means redelivery reprocesses from scratch; after
      // commit, redelivery is a no-op. Together that gives exactly-once *effect* for at-least-once *delivery*.
      const ins = await c.query('INSERT INTO inbound_updates (account_id, update_key) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING 1', [m.accountId, m.updateKey]);
      if (!ins.rowCount) return { status: 'duplicate' } as const;

      await this.storeMessage(c, p, m, text, confidence);

      let replyText: string | null;
      let kind: Extract<IntakeResult, { status: 'handled' }>['intent'];
      if (rejection) {
        replyText = t(p.locale, rejection.key, rejection.vars);
        kind = outcome ?? 'voice_rejected';
      } else {
        kind = intent!.kind;
        replyText = await this.execute(c, p, intent!);
      }
      if (replyText !== null) await this.reply(c, p, replyText);
      return { status: 'handled', intent: kind } as const;
    });
  }

  private async storeMessage(c: pg.PoolClient, p: Principal, m: IncomingMessage, text: string, confidence: number | null) {
    const { crypto, clock } = this.d;
    const conv = await c.query<{ id: string }>(
      `INSERT INTO conversations (owner_id, actor_role, channel, external_id) SELECT $1,'owner',$2,$3
       WHERE NOT EXISTS (SELECT 1 FROM conversations WHERE owner_id=$1 AND channel=$2 AND external_id=$3) RETURNING id`,
      [p.ownerId, m.voice ? 'telegram_voice_note' : 'telegram_text', m.chat.id],
    );
    const convId = conv.rows[0]?.id ?? (await c.query<{ id: string }>('SELECT id FROM conversations WHERE owner_id=$1 AND channel=$2 AND external_id=$3', [p.ownerId, m.voice ? 'telegram_voice_note' : 'telegram_text', m.chat.id])).rows[0]!.id;
    await c.query(
      `INSERT INTO messages (owner_id, conversation_id, account_id, provider_message_id, direction, content_enc, confidence, occurred_at, retention_expires_at)
       VALUES ($1,$2,$3,$4,'inbound',$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [p.ownerId, convId, m.accountId, m.providerMessageId, crypto.enc(p.ownerId, 'messages.content', text), confidence, m.receivedAt, new Date(clock.now().getTime() + MESSAGE_RETENTION_MS)],
    );
  }

  private async reply(c: pg.PoolClient, p: Principal, text: string) {
    await emitOutbox(c, { ownerId: p.ownerId, aggregateType: 'owner', aggregateId: p.ownerId, type: 'owner.reply', payload: { textEnc: this.d.crypto.enc(p.ownerId, 'outbox.reply', text) } }, this.d.clock.now());
  }

  /** Execute inside a savepoint: a DomainError becomes a user-facing reply and rolls back only that intent's writes. */
  private async execute(c: pg.PoolClient, p: Principal, intent: Intent): Promise<string | null> {
    await c.query('SAVEPOINT intent');
    try {
      const out = await this.run(c, p, intent);
      await c.query('RELEASE SAVEPOINT intent');
      return out;
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT intent');
      if (e instanceof DomainError) return this.errorText(p.locale, e);
      throw e;
    }
  }

  private errorText(loc: Locale, e: DomainError): string {
    const d = e.details as { code?: string; date?: string; time?: string; tz?: string } | undefined;
    if (e.code === 'invalid_input' && d?.code === 'in_the_past') return t(loc, 'in_the_past', { date: d.date, time: d.time, tz: d.tz });
    if (e.code === 'not_found') return t(loc, 'task_not_found');
    if (e.code === 'version_conflict') return t(loc, 'version_conflict');
    if (e.code === 'ref') return t(loc, (e.details as { key: MessageKey }).key);
    return t(loc, 'fallback_clarify');
  }

  private local(ld: LocalDateTime, tz: string) {
    const time = ld.time || '18:00';
    return { localDateTime: `${ld.date}T${time}`, ...resolveWallClock(`${ld.date}T${time}`, tz) };
  }

  private fmtDue(task: Task, tz: string): string {
    if (!task.dueAt) return '';
    const d = describeInstant(new Date(task.dueAt), tz);
    return ` — ${d.date} ${d.time}`;
  }

  private async saveSnapshot(c: pg.PoolClient, ownerId: string, kind: 'tasks' | 'reminders', ids: string[]) {
    await c.query('INSERT INTO list_snapshots (owner_id, kind, item_ids, created_at) VALUES ($1,$2,$3,$4)', [ownerId, kind, ids, this.d.clock.now()]);
  }

  private async resolveRef(c: pg.PoolClient, ownerId: string, kind: 'tasks' | 'reminders', ref: TaskRef): Promise<string> {
    const bad = (key: MessageKey) => Object.assign(new DomainError('ref', 'unresolved reference'), { details: { key } });
    if (ref.by === 'ordinal') {
      const s = await c.query<{ item_ids: string[]; created_at: Date }>('SELECT item_ids, created_at FROM list_snapshots WHERE owner_id=$1 AND kind=$2 ORDER BY created_at DESC LIMIT 1', [ownerId, kind]);
      const snap = s.rows[0];
      if (!snap) throw bad('ref_unresolved');
      if (this.d.clock.now().getTime() - snap.created_at.getTime() > SNAPSHOT_MAX_AGE_MS) throw bad('ref_stale');
      const id = snap.item_ids[ref.n - 1];
      if (!id) throw bad('ref_unresolved');
      return id;
    }
    if (kind === 'tasks') {
      const needle = ref.text.toLowerCase();
      const hits = (await this.d.tasks.list(c, ownerId)).filter((x) => x.title.toLowerCase().includes(needle));
      if (hits.length !== 1) throw bad('ref_unresolved'); // zero or ambiguous: ask, never guess
      return hits[0]!.id;
    }
    throw bad('ref_unresolved');
  }

  private async run(c: pg.PoolClient, p: Principal, intent: Intent): Promise<string | null> {
    const { tasks, reminders } = this.d;
    const loc = p.locale;
    switch (intent.kind) {
      case 'help':
        return t(loc, 'help');
      case 'unknown':
        return t(loc, 'unknown');
      case 'clarify':
        return intent.question;
      case 'stop_calling':
        await c.query('UPDATE owners SET call_opt_out=true WHERE id=$1', [p.ownerId]);
        await writeAudit(c, { ownerId: p.ownerId, actorType: 'owner', action: 'owner.call_opt_out', allowed: true, reasonCode: 'ok' });
        return t(loc, 'calls_stopped');
      case 'create_task': {
        const due = intent.due ? this.local(intent.due, p.timezone) : null;
        const task = await tasks.create(c, p.ownerId, { title: intent.title, dueAt: due?.utc });
        const dueText = due ? t(loc, 'task_due', { ...describeInstant(due.utc, p.timezone) }) : '';
        return t(loc, 'task_created', { title: task.title, due: dueText });
      }
      case 'list_tasks': {
        const list = await tasks.list(c, p.ownerId);
        if (!list.length) return t(loc, 'tasks_empty');
        await this.saveSnapshot(c, p.ownerId, 'tasks', list.map((x) => x.id));
        return [t(loc, 'tasks_header'), ...list.map((x, i) => `${i + 1}. ${x.title}${this.fmtDue(x, p.timezone)}`)].join('\n');
      }
      case 'complete_task': {
        const id = await this.resolveRef(c, p.ownerId, 'tasks', intent.ref);
        const cur = await tasks.get(c, p.ownerId, id);
        const done = await tasks.update(c, p.ownerId, id, cur.version, { status: 'done' });
        return t(loc, 'task_done', { title: done.title });
      }
      case 'reschedule_task': {
        const id = await this.resolveRef(c, p.ownerId, 'tasks', intent.ref);
        const cur = await tasks.get(c, p.ownerId, id);
        const due = this.local(intent.due, p.timezone);
        const moved = await tasks.update(c, p.ownerId, id, cur.version, { dueAt: due.utc });
        return t(loc, 'task_moved', { title: moved.title, ...describeInstant(due.utc, p.timezone) });
      }
      case 'create_reminder': {
        const when = this.local(intent.at, p.timezone);
        // The scheduling confirmation (with exact local date/time/zone) is emitted via the outbox by the service itself.
        await reminders.create(p.ownerId, { title: intent.title, localDateTime: when.localDateTime, ...(intent.recurrence ? { recurrence: intent.recurrence } : {}) }, c);
        return null;
      }
      case 'list_reminders': {
        const list = await reminders.listActive(p.ownerId);
        if (!list.length) return t(loc, 'reminders_empty');
        await this.saveSnapshot(c, p.ownerId, 'reminders', list.map((x) => x.id));
        return [t(loc, 'reminders_header'), ...list.map((x, i) => `${i + 1}. ${x.title} — ${x.next ? `${x.next.date} ${x.next.time}` : ''}`)].join('\n');
      }
      case 'reschedule_reminder': {
        const id = await this.resolveRef(c, p.ownerId, 'reminders', intent.ref);
        const cur = await reminders.get(p.ownerId, id);
        await reminders.reschedule(p.ownerId, id, cur.version, `${intent.at.date}T${intent.at.time}`, undefined, c);
        return null;
      }
      case 'cancel_reminder': {
        const id = await this.resolveRef(c, p.ownerId, 'reminders', intent.ref);
        const cur = await reminders.get(p.ownerId, id);
        await reminders.cancel(p.ownerId, id, cur.version, c);
        return null;
      }
    }
  }
}
export { DateTime };
