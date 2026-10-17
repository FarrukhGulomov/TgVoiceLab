import { DateTime } from 'luxon';
import type pg from 'pg';
import type { Db } from '../../infrastructure/db/db.js';
import type { DataCrypto } from '../../infrastructure/crypto/data-crypto.js';
import type { Clock } from '../../application/clock.js';
import type { ClarificationDraft, Intent, LocalDateTime, TaskRef } from '../../application/intent.js';
import type { PeerResolverPort, TextInterpreterPort, TranscriptionPort } from '../../application/ports.js';
import { DomainError } from '../../application/errors.js';
import { authenticateOwnerMessage, type Principal } from '../identity/identity.js';
import { emitOutbox } from '../outbox/outbox.js';
import { writeAudit } from '../audit/audit.js';
import type { TaskService, Task } from '../tasks/tasks.service.js';
import type { ReminderService } from '../scheduling/reminders.service.js';
import type { ContactService } from '../contacts/contacts.service.js';
import { CONTACT_CALL_MAX_SECONDS, type ContactCallService } from '../calls/contact-calls.service.js';
import { describeInstant, resolveWallClock } from '../scheduling/wallclock.js';
import { t, type Locale, type MessageKey } from './i18n.js';
import { Limiter, withTimeout } from '../../application/async.js';

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
  /**
   * `sizeBytes` is the size DECLARED by the provider. An adapter must NOT download media itself: it supplies a lazy `download`
   * and the intake service calls it only after the sender is authorized and every size/duration/format/transcription check passed
   * (audit F02). `bytes` is accepted for already-available payloads (tests, other adapters).
   */
  voice?: {
    mime: string;
    durationSeconds: number;
    sizeBytes?: number;
    bytes?: Uint8Array;
    download?: () => Promise<Uint8Array>;
  };
  forwarded?: boolean;
  /** A Telegram contact card the owner shared: its numeric id identifies the person without any lookup. */
  contactCard?: { userId: string; name: string };
}

export type IntakeResult =
  | { status: 'duplicate' }
  | { status: 'denied'; reason: string }
  | { status: 'handled'; intent: Intent['kind'] | 'voice_rejected' | 'forwarded_ignored' | 'voice_uncertain' };

const SUPPORTED_VOICE_MIME = /^audio\/(?:ogg|opus|mpeg|mp3|mp4|x-m4a|aac|wav|x-wav|webm)(?:\s*;.*)?$/i;

export class IntakeService {
  private readonly downloads: Limiter;
  private readonly downloadTimeoutMs: number;
  constructor(
    private readonly d: {
      db: Db;
      crypto: DataCrypto;
      clock: Clock;
      tasks: TaskService;
      reminders: ReminderService;
      interpreter: TextInterpreterPort;
      transcription?: TranscriptionPort | undefined;
      voiceDownloadTimeoutMs?: number;
      voiceMaxConcurrentDownloads?: number;
      /**
       * Owner opt-out scope: ALL assistant calls (owner and contact). `cancelAllCallIntents` runs inside the intake transaction;
       * `terminateAllLiveCalls` runs after it commits (audit F14, scope decided by the owner).
       */
      ownerCalls?: {
        cancelAllCallIntents(q: pg.PoolClient, ownerId: string): Promise<number>;
        terminateAllLiveCalls(ownerId: string): Promise<number>;
        cancelContactCallIntents(q: pg.PoolClient, ownerId: string, contactId: string): Promise<number>;
        terminateLiveContactCalls(ownerId: string, contactId: string): Promise<number>;
      };
      contacts?: ContactService;
      /** Resolves @username / +phone to a numeric id (Telegram-backed). Absent in tests and when messaging is disabled. */
      peers?: PeerResolverPort;
      /** Called with the failure (never the audio or its text) when a voice note could not be transcribed. */
      onVoiceError?: (e: Error) => void;
      /** Present only when calling is enabled in this deployment; without it a call to a contact is refused with an honest message. */
      contactCalls?: ContactCallService;
    },
  ) {
    this.downloads = new Limiter(d.voiceMaxConcurrentDownloads ?? 2);
    this.downloadTimeoutMs = d.voiceDownloadTimeoutMs ?? 30_000;
  }

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
      const declared = m.voice.sizeBytes ?? m.voice.bytes?.byteLength;
      if (m.voice.durationSeconds > VOICE_MAX_SECONDS) rejection = { key: 'voice_too_long', vars: { limit: VOICE_MAX_SECONDS / 60 } };
      else if (declared === undefined || declared > VOICE_MAX_BYTES) rejection = { key: 'voice_too_large' };
      else if (!SUPPORTED_VOICE_MIME.test(m.voice.mime)) rejection = { key: 'voice_unsupported_format' };
      else if (!this.d.transcription) rejection = { key: 'transcription_unavailable' };
      else {
        try {
          // Authorized + every cheap check passed: only now fetch the payload (bounded concurrency and time).
          const v = m.voice;
          const bytes =
            v.bytes ?? (v.download ? await this.downloads.run(() => withTimeout(v.download!(), this.downloadTimeoutMs, 'voice download')) : undefined);
          if (!bytes || bytes.byteLength > VOICE_MAX_BYTES) throw new Error('voice payload missing or over the byte cap');
          const tr = await this.d.transcription.transcribe({ bytes, mime: v.mime, durationSeconds: v.durationSeconds });
          text = tr.text;
          confidence = tr.confidence;
          if (tr.confidence < TRANSCRIPT_MIN_CONFIDENCE) {
            rejection = { key: 'voice_uncertain', vars: { text: tr.text.slice(0, 200) } };
            outcome = 'voice_uncertain';
          }
        } catch (e) {
          this.d.onVoiceError?.(e as Error);
          rejection = { key: 'voice_failed' };
        }
      }
      if (rejection && !outcome) outcome = 'voice_rejected';
    }

    const ictx = { receivedAt: m.receivedAt, timezone: p.timezone, locale: p.locale };
    let intent: Intent | null = rejection ? null : await this.d.interpreter.interpret(text, ictx);
    if (!rejection && m.contactCard && !m.forwarded) intent = { kind: 'add_contact', name: m.contactCard.name, telegramUserId: m.contactCard.userId };
    else if (intent?.kind === 'lookup_contact') {
      const q = intent;
      const hit = this.d.peers
        ? await this.d.peers.resolve({ ...(q.username ? { username: q.username } : {}), ...(q.phone ? { phone: q.phone } : {}) }).catch(() => null)
        : null;
      intent = hit
        ? { kind: 'add_contact', name: q.name || hit.displayName, telegramUserId: hit.telegramUserId, resolvedAs: hit.displayName }
        : { kind: 'clarify', question: t(p.locale, 'contact_not_found', { who: q.username ? `@${q.username}` : (q.phone ?? '') }) };
    }
    // A pending clarification (audit F16) is consulted ONLY when the message is not itself a concrete command, so "done 2" or
    // "add task ..." can never be mistaken for the answer. An expired or absent draft changes nothing.
    let draft: ClarificationDraft | null = null;
    let completed = false;
    if (intent && (intent.kind === 'unknown' || intent.kind === 'clarify')) {
      draft = await this.loadDraft(p.ownerId);
      if (draft && this.d.interpreter.completeDraft) {
        const done = await this.d.interpreter.completeDraft(text, draft, ictx);
        if (done) {
          intent = done;
          completed = true;
        }
      }
    }

    const afterCommit: Array<() => Promise<unknown>> = [];
    const result = await db.tx(async (c) => {
      // Durable dedupe + effect in ONE transaction: a crash before commit means redelivery reprocesses from scratch; after
      // commit, redelivery is a no-op. Together that gives exactly-once *effect* for at-least-once *delivery*.
      const ins = await c.query('INSERT INTO inbound_updates (account_id, update_key) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING 1', [
        m.accountId,
        m.updateKey,
      ]);
      if (!ins.rowCount) return { status: 'duplicate' } as const;

      await this.storeMessage(c, p, m, text, confidence);

      // A voice note is always answered with what was heard, so a mishearing is visible before (or next to) the confirmation.
      if (m.voice && !rejection && text.trim()) await this.reply(c, p, t(p.locale, 'voice_heard', { text: text.trim().slice(0, 300) }));

      let replyText: string | null;
      let kind: Extract<IntakeResult, { status: 'handled' }>['intent'];
      if (rejection) {
        replyText = t(p.locale, rejection.key, rejection.vars);
        kind = outcome ?? 'voice_rejected';
      } else {
        kind = intent!.kind;
        replyText = await this.execute(c, p, intent!, afterCommit);
        // Draft lifecycle inside the same transaction as the effect: completed or replaced by an explicit command -> gone;
        // a new question -> becomes the (single) draft; an unrelated message leaves a still-valid draft alone.
        if (completed || (intent!.kind !== 'unknown' && intent!.kind !== 'clarify'))
          await c.query('DELETE FROM conversation_drafts WHERE owner_id=$1', [p.ownerId]);
        else if (intent!.kind === 'clarify' && intent!.draft) await this.saveDraft(c, p.ownerId, intent!.draft);
      }
      if (replyText !== null) await this.reply(c, p, replyText);
      return { status: 'handled', intent: kind } as const;
    });
    // External effects (ending a live call) happen only after the transaction committed.
    if (result.status === 'handled') for (const f of afterCommit) await f().catch(() => undefined);
    return result;
  }

  /** TTL for a pending clarification: long enough to answer, short enough that a stale reply cannot create anything. */
  static readonly DRAFT_TTL_MS = 10 * 60_000;

  private async loadDraft(ownerId: string): Promise<ClarificationDraft | null> {
    const r = await this.d.db.query<{ draft_enc: string }>('SELECT draft_enc FROM conversation_drafts WHERE owner_id=$1 AND expires_at > $2', [
      ownerId,
      this.d.clock.now(),
    ]);
    if (!r.rows[0]) return null;
    try {
      return JSON.parse(this.d.crypto.dec(ownerId, 'conversation_drafts.draft', r.rows[0].draft_enc)) as ClarificationDraft;
    } catch {
      return null; // an unreadable draft is treated as absent: never act on it
    }
  }

  private async saveDraft(c: pg.PoolClient, ownerId: string, draft: ClarificationDraft): Promise<void> {
    const now = this.d.clock.now();
    await c.query(
      `INSERT INTO conversation_drafts (owner_id, kind, draft_enc, created_at, expires_at) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (owner_id) DO UPDATE SET kind=EXCLUDED.kind, draft_enc=EXCLUDED.draft_enc, created_at=EXCLUDED.created_at, expires_at=EXCLUDED.expires_at`,
      [
        ownerId,
        draft.kind,
        this.d.crypto.enc(ownerId, 'conversation_drafts.draft', JSON.stringify(draft)),
        now,
        new Date(now.getTime() + IntakeService.DRAFT_TTL_MS),
      ],
    );
  }

  private async storeMessage(c: pg.PoolClient, p: Principal, m: IncomingMessage, text: string, confidence: number | null) {
    const { crypto, clock } = this.d;
    const conv = await c.query<{ id: string }>(
      `INSERT INTO conversations (owner_id, actor_role, channel, external_id) SELECT $1,'owner',$2,$3
       WHERE NOT EXISTS (SELECT 1 FROM conversations WHERE owner_id=$1 AND channel=$2 AND external_id=$3) RETURNING id`,
      [p.ownerId, m.voice ? 'telegram_voice_note' : 'telegram_text', m.chat.id],
    );
    const convId =
      conv.rows[0]?.id ??
      (
        await c.query<{ id: string }>('SELECT id FROM conversations WHERE owner_id=$1 AND channel=$2 AND external_id=$3', [
          p.ownerId,
          m.voice ? 'telegram_voice_note' : 'telegram_text',
          m.chat.id,
        ])
      ).rows[0]!.id;
    await c.query(
      `INSERT INTO messages (owner_id, conversation_id, account_id, provider_message_id, direction, content_enc, confidence, occurred_at, retention_expires_at)
       VALUES ($1,$2,$3,$4,'inbound',$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [
        p.ownerId,
        convId,
        m.accountId,
        m.providerMessageId,
        crypto.enc(p.ownerId, 'messages.content', text),
        confidence,
        m.receivedAt,
        new Date(clock.now().getTime() + MESSAGE_RETENTION_MS),
      ],
    );
  }

  private async reply(c: pg.PoolClient, p: Principal, text: string) {
    await emitOutbox(
      c,
      {
        ownerId: p.ownerId,
        aggregateType: 'owner',
        aggregateId: p.ownerId,
        type: 'owner.reply',
        payload: { textEnc: this.d.crypto.enc(p.ownerId, 'outbox.reply', text) },
      },
      this.d.clock.now(),
    );
  }

  /** Execute inside a savepoint: a DomainError becomes a user-facing reply and rolls back only that intent's writes. */
  private async execute(c: pg.PoolClient, p: Principal, intent: Intent, afterCommit: Array<() => Promise<unknown>>): Promise<string | null> {
    await c.query('SAVEPOINT intent');
    try {
      const local: Array<() => Promise<unknown>> = [];
      const out = await this.run(c, p, intent, local);
      await c.query('RELEASE SAVEPOINT intent');
      afterCommit.push(...local); // only effects of an intent that actually committed
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
      const s = await c.query<{ item_ids: string[]; created_at: Date }>(
        'SELECT item_ids, created_at FROM list_snapshots WHERE owner_id=$1 AND kind=$2 ORDER BY created_at DESC LIMIT 1',
        [ownerId, kind],
      );
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

  private async run(c: pg.PoolClient, p: Principal, intent: Intent, afterCommit: Array<() => Promise<unknown>>): Promise<string | null> {
    const { tasks, reminders } = this.d;
    const loc = p.locale;
    switch (intent.kind) {
      case 'help':
        return t(loc, 'help');
      case 'unknown':
        return t(loc, 'unknown');
      case 'clarify':
        return intent.question;
      case 'stop_calling': {
        // The owner row update takes the lock a concurrent dial transaction also needs, so the two serialize (no handover gap).
        await c.query('UPDATE owners SET call_opt_out=true WHERE id=$1', [p.ownerId]);
        const owner = this.d.ownerCalls;
        const cancelled = owner ? await owner.cancelAllCallIntents(c, p.ownerId) : 0;
        if (owner) afterCommit.push(() => owner.terminateAllLiveCalls(p.ownerId));
        await writeAudit(c, {
          ownerId: p.ownerId,
          actorType: 'owner',
          action: 'owner.call_opt_out',
          allowed: true,
          reasonCode: 'ok',
          metadata: { scope: 'all_calls', cancelledRequests: cancelled },
        });
        return t(loc, 'calls_stopped');
      }
      case 'add_contact': {
        if (intent.telegramUserId === p.telegramUserId) return t(loc, 'contact_self');
        const contacts = this.d.contacts;
        if (!contacts) return t(loc, 'unknown');
        await contacts.addVouched(c, p.ownerId, { telegramUserId: intent.telegramUserId, displayName: intent.name }, this.d.clock.now());
        return t(loc, 'contact_added', {
          name: intent.name.trim(),
          id: intent.resolvedAs ? `${intent.telegramUserId}, Telegram: ${intent.resolvedAs}` : intent.telegramUserId,
        });
      }
      case 'lookup_contact':
        return t(loc, 'unknown'); // resolved to add_contact (or a clarification) before execution; never reaches here
      case 'remove_contact': {
        const contacts = this.d.contacts;
        if (!contacts) return t(loc, 'unknown');
        const r = await contacts.resolveByName(c, p.ownerId, intent.name);
        if (r.kind === 'none') return t(loc, 'contact_unknown', { name: intent.name });
        if (r.kind === 'many') return t(loc, 'contact_ambiguous', { name: intent.name, names: r.names.join(', ') });
        await contacts.removeVouched(c, p.ownerId, r.contact.id, this.d.clock.now());
        const ops = this.d.ownerCalls;
        if (ops) {
          await ops.cancelContactCallIntents(c, p.ownerId, r.contact.id);
          afterCommit.push(() => ops.terminateLiveContactCalls(p.ownerId, r.contact.id));
        }
        return t(loc, 'contact_removed', { name: r.contact.displayName });
      }
      case 'list_contacts': {
        const contacts = this.d.contacts;
        if (!contacts) return t(loc, 'unknown');
        const list = await contacts.list(c, p.ownerId);
        if (!list.length) return t(loc, 'contacts_empty');
        return [t(loc, 'contacts_header'), ...list.map((x, i) => `${i + 1}. ${x.displayName} (id ${x.telegramUserId})${x.active ? '' : ' — off'}`)].join('\n');
      }
      case 'set_owner_name': {
        const name = intent.name.trim().slice(0, 80);
        await c.query('UPDATE owners SET display_name=$2 WHERE id=$1', [p.ownerId, name]);
        return t(loc, 'owner_name_set', { name });
      }
      case 'call_contact': {
        const contacts = this.d.contacts;
        if (!contacts) return t(loc, 'unknown');
        const r = await contacts.resolveByName(c, p.ownerId, intent.contact);
        if (r.kind === 'none') return t(loc, 'contact_unknown', { name: intent.contact });
        if (r.kind === 'many') return t(loc, 'contact_ambiguous', { name: intent.contact, names: r.names.join(', ') });
        if (!this.d.contactCalls) return t(loc, 'contact_call_unavailable', { name: r.contact.displayName });
        const due = intent.at ? this.local(intent.at, p.timezone) : null;
        const res = await this.d.contactCalls.request(c, p.ownerId, { contactId: r.contact.id, message: intent.message, dueAt: due?.utc, language: loc });
        if (!res.ok)
          return res.reason === 'empty_message'
            ? t(loc, 'ask_call_message', { name: r.contact.displayName })
            : t(loc, 'contact_call_no_permission', { name: r.contact.displayName });
        const when = describeInstant(res.dueAt, p.timezone);
        return t(loc, 'contact_call_queued', {
          name: r.contact.displayName,
          ...when,
          minutes: CONTACT_CALL_MAX_SECONDS / 60,
          message: intent.message.trim().slice(0, 200),
        });
      }
      case 'set_briefing': {
        // The scheduling confirmation (with the exact local time and zone) is emitted via the outbox by the service itself.
        await reminders.setBriefing(p.ownerId, intent.time, c);
        return null;
      }
      case 'cancel_briefing': {
        // On success the cancellation notice travels through the outbox; "nothing to cancel" is answered directly.
        return (await reminders.cancelBriefing(p.ownerId, c)) ? null : t(loc, 'briefing_none');
      }
      case 'create_task': {
        const due = intent.due ? this.local(intent.due, p.timezone) : null;
        const task = await tasks.create(c, p.ownerId, { title: intent.title, dueAt: due?.utc });
        const dueText = due ? t(loc, 'task_due', { ...describeInstant(due.utc, p.timezone) }) : '';
        return t(loc, 'task_created', { title: task.title, due: dueText });
      }
      case 'list_tasks': {
        const list = await tasks.list(c, p.ownerId);
        if (!list.length) return t(loc, 'tasks_empty');
        await this.saveSnapshot(
          c,
          p.ownerId,
          'tasks',
          list.map((x) => x.id),
        );
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
        await reminders.create(
          p.ownerId,
          {
            title: intent.title,
            localDateTime: when.localDateTime,
            ...(intent.recurrence ? { recurrence: intent.recurrence } : {}),
            ...(intent.byCall ? { mode: 'call' as const } : {}),
          },
          c,
        );
        return null;
      }
      case 'list_reminders': {
        const list = await reminders.listActive(p.ownerId);
        if (!list.length) return t(loc, 'reminders_empty');
        await this.saveSnapshot(
          c,
          p.ownerId,
          'reminders',
          list.map((x) => x.id),
        );
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
