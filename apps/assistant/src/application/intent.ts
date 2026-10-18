/** Structured intents the text interpreter may *propose*. Application code validates and executes them. */
export type TaskRef =
  | { by: 'ordinal'; n: number } // "the second task" -> resolved against the latest list snapshot
  | { by: 'text'; text: string };

export interface LocalDateTime {
  /** YYYY-MM-DD */
  date: string;
  /** HH:mm, 24h. */
  time: string;
}

export interface RecurrenceIntent {
  freq: 'daily' | 'weekly' | 'monthly';
  interval: number;
  byWeekday?: number[];
}

/**
 * What the assistant is waiting to learn to finish an action it already understood part of (audit F16). One bounded, expiring draft
 * per owner; it carries only the structured missing field, and the next compatible reply completes it. Nothing is executed
 * until the completed action is shown back with its exact date and time.
 */
export interface ReminderDraft {
  kind: 'create_reminder';
  title: string;
  date: string; // YYYY-MM-DD, already resolved
  recurrence?: RecurrenceIntent;
  /** The owner asked to be reminded BY CALL. */
  byCall?: boolean;
  missing: 'time' | 'ambiguous_time';
  /** For `ambiguous_time`: the hour the owner wrote (1-12), to be resolved to morning or evening. */
  ambiguousHour?: number;
}
/**
 * A call the text AI proposed from free-form wording. Nothing rings until the owner confirms ("ha"); the draft carries exactly what
 * would be said, so the confirmation is for a concrete action, not for the model's guess.
 */
export interface CallConfirmDraft {
  kind: 'confirm_call';
  contact: string;
  message: string;
  slots?: LocalDateTime[];
}
/** A text message to a contact that the text AI composed; it is sent only after the owner confirms the exact words. */
export interface MessageConfirmDraft {
  kind: 'confirm_message';
  contact: string;
  text: string;
}
/** The owner is asked to confirm that no real call is live before stuck (`outcome_unknown`) calls are cleared. */
export interface ClearCallsDraft {
  kind: 'confirm_clear_calls';
}
export type ClarificationDraft = ReminderDraft | CallConfirmDraft | MessageConfirmDraft | ClearCallsDraft;

export type Intent =
  | { kind: 'create_task'; title: string; due?: LocalDateTime }
  | { kind: 'list_tasks' }
  | { kind: 'complete_task'; ref: TaskRef }
  | { kind: 'reschedule_task'; ref: TaskRef; due: LocalDateTime }
  | { kind: 'create_reminder'; title: string; at: LocalDateTime; recurrence?: RecurrenceIntent; byCall?: boolean }
  | { kind: 'reschedule_reminder'; ref: TaskRef; at: LocalDateTime }
  | { kind: 'cancel_reminder'; ref: TaskRef }
  | { kind: 'list_reminders' }
  | { kind: 'add_contact'; name: string; telegramUserId: string; resolvedAs?: string }
  | { kind: 'lookup_contact'; name: string; username?: string; phone?: string }
  | { kind: 'remove_contact'; name: string }
  | { kind: 'list_contacts' }
  /** Ring a contact on the owner's behalf. `contact` is the name as spoken/typed (resolved against the owner's contacts, never guessed). */
  | {
      kind: 'call_contact';
      contact: string;
      message: string;
      at?: LocalDateTime;
      /** Meeting times the owner offers; the AI may confirm only one of these. */ slots?: LocalDateTime[];
    }
  /** Send a plain Telegram text to a contact in the owner's name (the owner confirmed the exact words). */
  | { kind: 'message_contact'; contact: string; text: string }
  /** The owner declined or withdrew the proposal that is waiting for a yes/no. */
  | { kind: 'cancel_pending' }
  /** Keep a fact in the owner's memory (optionally about one contact). */
  | { kind: 'remember'; text: string; contact?: string }
  | { kind: 'list_memories' }
  | { kind: 'forget_memory'; ref: TaskRef }
  /** A conversational answer (no state change): the text AI chats, answers questions about the owner's tasks, calls and memory. */
  | { kind: 'reply'; text: string }
  /** "Tell me when X replies": by text (the default for every reply anyway) or by ringing the owner once. */
  | { kind: 'watch_contact'; contact: string; mode: 'text' | 'call' }
  /** The hours this contact may be called in (the contact's local time). `hours: null` = any time of day. */
  | { kind: 'set_contact_hours'; contact: string; hours: { start: string; end: string } | null }
  /** "Call me now" — ring the owner right away (through the call-reminder path: kill switch, quiet hours, opt-out apply). */
  | { kind: 'call_owner'; reason?: string }
  /** Free the calling account from calls whose outcome is unknown, after the owner confirmed there is no live call. */
  | { kind: 'clear_stuck_calls'; confirmed?: boolean }
  | { kind: 'set_owner_name'; name: string }
  | { kind: 'set_briefing'; time: string } // HH:mm, daily
  | { kind: 'cancel_briefing' }
  | { kind: 'stop_calling' }
  | { kind: 'help' }
  | { kind: 'clarify'; question: string; draft?: ClarificationDraft }
  | { kind: 'unknown' };

export interface InterpretContext {
  /** Original receipt time of the message — relative dates resolve against this, not processing time. */
  receivedAt: Date;
  timezone: string;
  locale: 'uz' | 'en' | 'ru';
  /** Only for the free-form fallback: what the model may use to understand a short reply such as "roziman". */
  background?: {
    contacts: string[];
    /** The latest call report (within a few hours), so "I agree" can be tied to the call it answers. */
    recentCall?: { contact: string; outcome: string; summary: string };
    /** The last few exchanges, oldest first, so a short reply is read in the light of what was just said. */
    history?: Array<{ from: 'owner' | 'assistant'; text: string }>;
    /** What the assistant remembers that is relevant (the owner's notes and notes about contacts named in the message). */
    memories?: string[];
    /** Read-only snapshot for answering questions (the owner's own data). */
    tasks?: string[];
    reminders?: string[];
    /** Recent call reports, newest first: "Contact (outcome, when): summary". */
    calls?: string[];
    /** What the assistant is waiting for a yes/no on, if anything. */
    pending?: string;
  };
}

/** Title of the call reminder created by "call me now"; the owner call recognises it and just asks how it can help. */
export const OWNER_REQUESTED_CALL = "Siz so'ragan qo'ng'iroq";
