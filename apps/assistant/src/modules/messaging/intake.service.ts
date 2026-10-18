import { DateTime } from 'luxon';
import type pg from 'pg';
import type { Db } from '../../infrastructure/db/db.js';
import type { DataCrypto } from '../../infrastructure/crypto/data-crypto.js';
import type { Clock } from '../../application/clock.js';
import { OWNER_REQUESTED_CALL } from '../../application/intent.js';
import type { ClarificationDraft, Intent, InterpretContext, LocalDateTime, TaskRef } from '../../application/intent.js';
import type { IntentFallbackPort, PeerResolverPort, TextInterpreterPort, TranscriptionPort } from '../../application/ports.js';
import { DomainError } from '../../application/errors.js';
import { authenticateOwnerMessage, type Principal } from '../identity/identity.js';
import { emitOutbox } from '../outbox/outbox.js';
import { writeAudit } from '../audit/audit.js';
import type { TaskService, Task } from '../tasks/tasks.service.js';
import type { ReminderService } from '../scheduling/reminders.service.js';
import type { ContactService } from '../contacts/contacts.service.js';
import { ContactWatchService } from '../contacts/watches.js';
import { MemoryService, OWNER_SCOPE, contactScope } from '../memory/memory.service.js';
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
  | { status: 'handled'; intent: Intent['kind'] | 'voice_rejected' | 'forwarded_ignored' | 'voice_uncertain' | 'contact_relayed' };

/** Replies relayed per contact per hour; more are dropped (a contact cannot flood the owner). */
/** How many of the question's words (compared by their first letters, so "Onixni" meets "Onix") occur in a stored text. */
export function relevance(stored: string, question: string): number {
  const stems = (x: string) => new Set((x.toLowerCase().match(/[\p{L}\p{N}']{4,}/gu) ?? []).map((w) => w.replace(/'/g, '').slice(0, 4)));
  const have = stems(stored);
  let n = 0;
  for (const w of stems(question)) if (have.has(w)) n++;
  return n;
}

const RELAY_PER_HOUR = 20;

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
      /** Free-form understanding for text the rules did not recognise. Absent = such text stays "unknown". */
      fallback?: IntentFallbackPort;
      /** Called with the failure (never the text) when the fallback could not answer. */
      onFallbackError?: (e: Error) => void;
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
        listUnknownCalls?(q: pg.PoolClient | Db, ownerId: string): Promise<string[]>;
        listOpenCallStates?(q: pg.PoolClient | Db, ownerId: string): Promise<string[]>;
        resolveAllUnknownCalls?(q: pg.PoolClient, ownerId: string, now: Date): Promise<number>;
        terminateLiveContactCalls(ownerId: string, contactId: string): Promise<number>;
      };
      contacts?: ContactService;
      /** Owner-controlled memory ("eslab qol", "xotira", "unut"); also gives the free-form fallback what it remembers. */
      memory?: MemoryService;
      /** "Tell me when X replies" watches; a relayed reply consumes a `call` watch. */
      watches?: ContactWatchService;
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
    if (!auth.ok) {
      // A vouched contact answering the assistant is relayed to the owner (as plain data, never as a command). Strangers stay silent.
      if (auth.reason === 'unknown_sender') {
        const relayed = await this.relayFromContact(m);
        if (relayed) return relayed;
      }
      return { status: 'denied', reason: auth.reason }; // silent: no reply to strangers, no state change
    }
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
    else if (intent?.kind === 'clear_stuck_calls' && !intent.confirmed) {
      // Never clears on its own: first say what is stuck and ask whether the real phone shows a live call.
      const ops = this.d.ownerCalls;
      const stuck = ops?.listUnknownCalls ? (await ops.listUnknownCalls(db, p.ownerId)).length : 0;
      const open = ops?.listOpenCallStates ? await ops.listOpenCallStates(db, p.ownerId) : [];
      intent = stuck
        ? { kind: 'clarify', question: t(p.locale, 'clear_calls_confirm', { n: stuck }), draft: { kind: 'confirm_clear_calls' } }
        : {
            kind: 'clarify',
            question: open.length ? t(p.locale, 'clear_calls_other', { states: [...new Set(open)].join(', ') }) : t(p.locale, 'clear_calls_none'),
          };
    } else if (intent?.kind === 'message_contact') {
      // A text the owner typed for a contact is still shown back and sent only after "ha".
      const m = intent;
      intent = {
        kind: 'clarify',
        question: t(p.locale, 'confirm_message', { name: m.contact, message: m.text.slice(0, 600) }),
        draft: { kind: 'confirm_message', contact: m.contact, text: m.text },
      };
    } else if (intent?.kind === 'lookup_contact') {
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

    // Still not understood: ask the free-form fallback. It sees the contact names and the latest call report so a short reply
    // ("roziman") can be tied to that call. A call it proposes is never placed from a guess: it becomes a question first.
    if (!rejection && !completed && intent?.kind === 'unknown' && this.d.fallback && text.trim()) {
      const open = draft ?? (await this.loadDraft(p.ownerId));
      const pending =
        open?.kind === 'confirm_call'
          ? t(p.locale, 'confirm_call', { name: open.contact, message: open.message.slice(0, 400) })
          : open?.kind === 'confirm_message'
            ? t(p.locale, 'confirm_message', { name: open.contact, message: open.text.slice(0, 600) })
            : undefined;
      try {
        const proposed = await this.d.fallback.propose(text, { ...ictx, background: await this.background(p.ownerId, text, pending) });
        if (proposed.kind === 'call_contact') {
          const draft2: ClarificationDraft = {
            kind: 'confirm_call',
            contact: proposed.contact,
            message: proposed.message,
            ...(proposed.slots?.length ? { slots: proposed.slots } : {}),
          };
          intent = {
            kind: 'clarify',
            question: t(p.locale, 'confirm_call', { name: proposed.contact, message: proposed.message.slice(0, 400) }),
            draft: draft2,
          };
        } else if (proposed.kind === 'message_contact') {
          intent = {
            kind: 'clarify',
            question: t(p.locale, 'confirm_message', { name: proposed.contact, message: proposed.text.slice(0, 600) }),
            draft: { kind: 'confirm_message', contact: proposed.contact, text: proposed.text },
          };
        } else intent = proposed;
      } catch (e) {
        this.d.onFallbackError?.(e as Error);
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
        if (completed || (intent!.kind !== 'unknown' && intent!.kind !== 'clarify' && intent!.kind !== 'reply'))
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

  /**
   * A message from one of the owner's vouched contacts to the assistant account: it is shown to the owner verbatim (quoted, as data) and,
   * if the owner asked to be called when this contact replies, the owner is also rung once through the reminder-call path.
   * Bounded: at most RELAY_PER_HOUR relays per contact per hour; voice and files are reported as such, never downloaded.
   */
  private async relayFromContact(m: IncomingMessage): Promise<IntakeResult | null> {
    if (m.chat.type !== 'private' || m.chat.id !== m.senderTelegramId) return null;
    const { db, clock } = this.d;
    const c0 = (
      await db.query<{ id: string; owner_id: string; display_name: string; locale: Locale; timezone: string }>(
        `SELECT c.id, c.owner_id, c.display_name, o.locale, o.timezone
           FROM contacts c JOIN telegram_accounts a ON a.owner_id=c.owner_id AND a.id=$1 JOIN owners o ON o.id=c.owner_id
          WHERE c.telegram_user_id=$2 AND c.verified_at IS NOT NULL AND c.ai_consent_attested_at IS NOT NULL
            AND (c.ai_consent_revoked_at IS NULL OR c.ai_consent_revoked_at < c.ai_consent_attested_at)`,
        [m.accountId, m.senderTelegramId],
      )
    ).rows[0];
    if (!c0 || !this.d.reminders) return null;
    const now = clock.now();
    const handled = { status: 'handled', intent: 'contact_relayed' } as const;
    return db.tx(async (c) => {
      const ins = await c.query('INSERT INTO inbound_updates (account_id, update_key) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING 1', [
        m.accountId,
        m.updateKey,
      ]);
      if (!ins.rowCount) return { status: 'duplicate' } as const;
      const recent = await c.query(
        `SELECT 1 FROM audit_events WHERE owner_id=$1 AND action='contact.relay' AND resource_id=$2 AND created_at > $3::timestamptz - interval '1 hour' OFFSET $4 LIMIT 1`,
        [c0.owner_id, c0.id, now, RELAY_PER_HOUR - 1],
      );
      if (recent.rowCount) return handled; // a flood from one contact is dropped, not relayed
      await writeAudit(c, {
        ownerId: c0.owner_id,
        actorType: 'contact',
        action: 'contact.relay',
        resourceType: 'contact',
        resourceId: c0.id,
        allowed: true,
        reasonCode: 'ok',
      });
      const body = (m.text ?? '').trim().slice(0, 1500);
      const text = body ? t(c0.locale, 'contact_relay', { name: c0.display_name, text: body }) : t(c0.locale, 'contact_relay_media', { name: c0.display_name });
      await this.reply(c, { ownerId: c0.owner_id, telegramUserId: '', locale: c0.locale, timezone: c0.timezone }, text);
      const mode = this.d.watches ? await this.d.watches.take(c, c0.owner_id, c0.id, now) : null;
      if (mode === 'call') {
        // Ring the owner through the normal reminder-call path (it respects the kill switch, quiet hours and the opt-out).
        const at = DateTime.fromJSDate(new Date(now.getTime() + 60_000), { zone: c0.timezone }).toFormat("yyyy-LL-dd'T'HH:mm");
        await this.d.reminders!.create(
          c0.owner_id,
          {
            title: `${c0.display_name} javob yozdi${body ? `: ${body.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`,
            localDateTime: at,
            mode: 'call',
            silent: true,
          },
          c,
        );
      }
      return handled;
    });
  }

  private async contactNames(q: pg.PoolClient, ownerId: string): Promise<Map<string, string>> {
    const r = await q.query<{ id: string; display_name: string }>('SELECT id, display_name FROM contacts WHERE owner_id=$1', [ownerId]);
    return new Map(r.rows.map((x) => [x.id, x.display_name]));
  }

  private async background(ownerId: string, text: string, pending?: string): Promise<NonNullable<InterpretContext['background']>> {
    const contacts = this.d.contacts ? (await this.d.contacts.list(this.d.db, ownerId)).filter((c) => c.active).map((c) => c.displayName) : [];
    const r = (
      await this.d.db.query<{ narrative_enc: string | null; display_name: string; outcome: string }>(
        `SELECT rp.narrative_enc, c.display_name, rp.structured_result->>'outcome' AS outcome
           FROM call_reports rp JOIN calls k ON k.id=rp.call_id JOIN call_requests q ON q.id=k.call_request_id JOIN contacts c ON c.id=q.contact_id
          WHERE rp.owner_id=$1 AND rp.complete AND rp.created_at > $2 ORDER BY rp.created_at DESC LIMIT 1`,
        [ownerId, new Date(this.d.clock.now().getTime() - 6 * 3_600_000)],
      )
    ).rows[0];
    const summary = r?.narrative_enc ? this.d.crypto.dec(ownerId, 'call_reports.narrative', r.narrative_enc) : '';
    const said = (
      await this.d.db.query<{ content_enc: string; occurred_at: Date }>(
        `SELECT content_enc, occurred_at FROM messages WHERE owner_id=$1 AND direction='inbound' AND occurred_at > $2 ORDER BY occurred_at DESC LIMIT 6`,
        [ownerId, new Date(this.d.clock.now().getTime() - 6 * 3_600_000)],
      )
    ).rows.map((x) => ({ at: x.occurred_at.getTime(), from: 'owner' as const, text: this.d.crypto.dec(ownerId, 'messages.content', x.content_enc) }));
    const replied = (
      await this.d.db.query<{ payload: { textEnc?: string }; created_at: Date }>(
        `SELECT payload, created_at FROM outbox WHERE owner_id=$1 AND type='owner.reply' AND created_at > $2 ORDER BY created_at DESC LIMIT 6`,
        [ownerId, new Date(this.d.clock.now().getTime() - 6 * 3_600_000)],
      )
    ).rows.flatMap((x) =>
      x.payload.textEnc
        ? [{ at: x.created_at.getTime(), from: 'assistant' as const, text: this.d.crypto.dec(ownerId, 'outbox.reply', x.payload.textEnc) }]
        : [],
    );
    const history = [...said, ...replied]
      .sort((a, b) => a.at - b.at)
      .slice(-8)
      .map(({ from, text }) => ({ from, text: text.slice(0, 400) }));
    // What the assistant remembers that bears on this message: the owner's own notes, plus notes about any contact the message names.
    let memories: string[] = [];
    if (this.d.memory) {
      const now = this.d.clock.now();
      const low = text.toLowerCase();
      const all = this.d.contacts ? await this.d.contacts.list(this.d.db, ownerId) : [];
      const named = all.filter((x) => low.includes(x.displayName.toLowerCase()) || (r && r.display_name === x.displayName));
      const names = new Map(all.map((x) => [contactScope(x.id), x.displayName]));
      // Every contact's notes are searchable, so "Onixni qancha baholadi?" finds what Test2 said even if the question names nobody.
      const scopes = [OWNER_SCOPE, ...all.map((x) => contactScope(x.id))];
      const namedScopes = new Set(named.map((x) => contactScope(x.id)));
      const items = await this.d.memory.list(this.d.db, ownerId, scopes, 80, now);
      const ranked = items
        .map((m, i) => ({ m, i, score: relevance(m.text, text) + (namedScopes.has(m.scope) ? 2 : 0) + (m.scope === OWNER_SCOPE ? 0.5 : 0) }))
        .sort((x, y) => y.score - x.score || x.i - y.i)
        .slice(0, 25);
      memories = ranked.map(({ m }) => (names.has(m.scope) ? `${names.get(m.scope)}: ${m.text}` : m.text));
    }
    // Read-only snapshot so the model can answer questions about the owner's own tasks, reminders and calls.
    const tasks = this.d.tasks
      ? (await this.d.tasks.list(this.d.db, ownerId, { limit: 15 })).map((x) => `${x.title}${x.dueAt ? ` (muddat: ${x.dueAt})` : ''}`)
      : [];
    const rems = (
      await this.d.db.query<{ title_enc: string; next_occurrence_at: Date | null; timezone: string }>(
        `SELECT title_enc, next_occurrence_at, timezone FROM reminders WHERE owner_id=$1 AND status='active' ORDER BY next_occurrence_at NULLS LAST LIMIT 10`,
        [ownerId],
      )
    ).rows.map(
      (x) =>
        `${this.d.crypto.dec(ownerId, 'reminders.title', x.title_enc)}${
          x.next_occurrence_at ? ` (${DateTime.fromJSDate(x.next_occurrence_at, { zone: x.timezone }).toFormat('yyyy-LL-dd HH:mm')})` : ''
        }`,
    );
    // Call history (30 days): the reports that match the question (by contact name or topic words) come first and are given in full.
    const callRows = (
      await this.d.db.query<{ narrative_enc: string | null; display_name: string; outcome: string; created_at: Date }>(
        `SELECT rp.narrative_enc, c.display_name, rp.structured_result->>'outcome' AS outcome, rp.created_at
           FROM call_reports rp JOIN calls k ON k.id=rp.call_id JOIN call_requests q ON q.id=k.call_request_id JOIN contacts c ON c.id=q.contact_id
          WHERE rp.owner_id=$1 AND rp.complete AND rp.created_at > $2 ORDER BY rp.created_at DESC LIMIT 40`,
        [ownerId, new Date(this.d.clock.now().getTime() - 30 * 86_400_000)],
      )
    ).rows.map((x, i) => {
      const body = x.narrative_enc ? this.d.crypto.dec(ownerId, 'call_reports.narrative', x.narrative_enc).replace(/\s+/g, ' ') : '';
      const named = text.toLowerCase().includes(x.display_name.toLowerCase());
      return { x, i, body, score: relevance(body, text) + (named ? 3 : 0) };
    });
    const calls = callRows
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .slice(0, 12)
      .map(
        ({ x, body, score }, k) =>
          `${x.display_name} (${x.outcome}, ${x.created_at.toISOString().slice(0, 16)}Z): ${body.slice(0, score > 0 || k < 3 ? 1200 : 300)}`,
      );
    return {
      contacts,
      ...(tasks.length ? { tasks } : {}),
      ...(rems.length ? { reminders: rems } : {}),
      ...(calls.length ? { calls } : {}),
      ...(memories.length ? { memories } : {}),
      ...(history.length ? { history } : {}),
      ...(pending ? { pending } : {}),
      ...(r && summary ? { recentCall: { contact: r.display_name, outcome: r.outcome, summary: summary.slice(0, 800) } } : {}),
    };
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
        await this.d.memory?.forgetContact(c, p.ownerId, r.contact.id);
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
      case 'remember': {
        const mem = this.d.memory;
        if (!mem) return t(loc, 'unknown');
        let scope = OWNER_SCOPE;
        let who = '';
        if (intent.contact && this.d.contacts) {
          const r = await this.d.contacts.resolveByName(c, p.ownerId, intent.contact);
          if (r.kind === 'none') return t(loc, 'contact_unknown', { name: intent.contact });
          if (r.kind === 'many') return t(loc, 'contact_ambiguous', { name: intent.contact, names: r.names.join(', ') });
          scope = contactScope(r.contact.id);
          who = r.contact.displayName;
        }
        const saved = await mem.remember(c, p.ownerId, scope, intent.text, { source: 'owner_command' }, this.d.clock.now());
        return saved ? t(loc, 'memory_saved', { text: saved.text, who: who ? ` (${who})` : '' }) : t(loc, 'memory_known');
      }
      case 'list_memories': {
        const mem = this.d.memory;
        if (!mem) return t(loc, 'unknown');
        const items = await mem.listAll(c, p.ownerId, 30, this.d.clock.now());
        if (!items.length) return t(loc, 'memory_empty');
        const names = await this.contactNames(c, p.ownerId);
        const lines = items.map((m, i) => {
          const cid = /^contact:([0-9a-f-]{36}):notes$/.exec(m.scope)?.[1];
          return `${i + 1}. ${cid ? `[${names.get(cid) ?? '?'}] ` : ''}${m.text}`;
        });
        return t(loc, 'memory_list', { list: lines.join('\n') });
      }
      case 'forget_memory': {
        const mem = this.d.memory;
        if (!mem) return t(loc, 'unknown');
        const items = await mem.listAll(c, p.ownerId, 30, this.d.clock.now());
        const ref = intent.ref;
        const hit = ref.by === 'ordinal' ? items[ref.n - 1] : items.find((m) => m.text.toLowerCase().includes(ref.text.toLowerCase()));
        if (!hit) return t(loc, 'memory_not_found');
        await mem.forget(c, p.ownerId, hit.id);
        return t(loc, 'memory_forgotten', { text: hit.text });
      }
      case 'watch_contact': {
        const contacts = this.d.contacts;
        const watches = this.d.watches;
        if (!contacts || !watches) return t(loc, 'unknown');
        const r = await contacts.resolveByName(c, p.ownerId, intent.contact);
        if (r.kind === 'none') return t(loc, 'contact_unknown', { name: intent.contact });
        if (r.kind === 'many') return t(loc, 'contact_ambiguous', { name: intent.contact, names: r.names.join(', ') });
        await watches.set(c, p.ownerId, r.contact.id, intent.mode, this.d.clock.now());
        return t(loc, intent.mode === 'call' ? 'watch_set_call' : 'watch_set_text', { name: r.contact.displayName });
      }
      case 'call_owner': {
        const rem = this.d.reminders;
        if (!rem) return t(loc, 'unknown');
        // Same path as a call reminder, due right now: kill switch, quiet hours, opt-out and gates still apply.
        const at = DateTime.fromJSDate(this.d.clock.now(), { zone: p.timezone }).toFormat("yyyy-LL-dd'T'HH:mm");
        await rem.create(
          p.ownerId,
          { title: intent.reason ?? OWNER_REQUESTED_CALL, localDateTime: at, mode: 'call', silent: true, fireAt: this.d.clock.now() },
          c,
        );
        return t(loc, 'call_owner_ok');
      }
      case 'clear_stuck_calls': {
        const ops = this.d.ownerCalls;
        if (!intent.confirmed || !ops?.resolveAllUnknownCalls) return t(loc, 'unknown');
        const n = await ops.resolveAllUnknownCalls(c, p.ownerId, this.d.clock.now());
        return t(loc, 'clear_calls_done', { n });
      }
      case 'reply':
        return intent.text;
      case 'cancel_pending':
        return t(loc, 'proposal_cancelled');
      case 'message_contact': {
        const contacts = this.d.contacts;
        if (!contacts) return t(loc, 'unknown');
        const r = await contacts.resolveByName(c, p.ownerId, intent.contact);
        if (r.kind === 'none') return t(loc, 'contact_unknown', { name: intent.contact });
        if (r.kind === 'many') return t(loc, 'contact_ambiguous', { name: intent.contact, names: r.names.join(', ') });
        const text = intent.text.trim().slice(0, 2000);
        if (!text) return t(loc, 'unknown');
        await emitOutbox(
          c,
          {
            ownerId: p.ownerId,
            aggregateType: 'contact',
            aggregateId: r.contact.id,
            type: 'contact.message',
            payload: { contactId: r.contact.id, textEnc: this.d.crypto.enc(p.ownerId, 'outbox.contact_message', text) },
          },
          this.d.clock.now(),
        );
        return t(loc, 'contact_message_queued', { name: r.contact.displayName });
      }
      case 'call_contact': {
        const contacts = this.d.contacts;
        if (!contacts) return t(loc, 'unknown');
        const r = await contacts.resolveByName(c, p.ownerId, intent.contact);
        if (r.kind === 'none') return t(loc, 'contact_unknown', { name: intent.contact });
        if (r.kind === 'many') return t(loc, 'contact_ambiguous', { name: intent.contact, names: r.names.join(', ') });
        if (!this.d.contactCalls) return t(loc, 'contact_call_unavailable', { name: r.contact.displayName });
        const due = intent.at ? this.local(intent.at, p.timezone) : null;
        const slots = (intent.slots ?? []).map((x) => this.local(x, p.timezone).utc);
        const res = await this.d.contactCalls.request(c, p.ownerId, {
          contactId: r.contact.id,
          message: intent.message,
          dueAt: due?.utc,
          language: loc,
          ...(slots.length ? { slots } : {}),
        });
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
