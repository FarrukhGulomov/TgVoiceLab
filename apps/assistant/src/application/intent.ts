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
export type ClarificationDraft = ReminderDraft | CallConfirmDraft;

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
  };
}
