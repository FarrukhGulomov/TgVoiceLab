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
  missing: 'time' | 'ambiguous_time';
  /** For `ambiguous_time`: the hour the owner wrote (1-12), to be resolved to morning or evening. */
  ambiguousHour?: number;
}
export type ClarificationDraft = ReminderDraft;

export type Intent =
  | { kind: 'create_task'; title: string; due?: LocalDateTime }
  | { kind: 'list_tasks' }
  | { kind: 'complete_task'; ref: TaskRef }
  | { kind: 'reschedule_task'; ref: TaskRef; due: LocalDateTime }
  | { kind: 'create_reminder'; title: string; at: LocalDateTime; recurrence?: RecurrenceIntent }
  | { kind: 'reschedule_reminder'; ref: TaskRef; at: LocalDateTime }
  | { kind: 'cancel_reminder'; ref: TaskRef }
  | { kind: 'list_reminders' }
  | { kind: 'stop_calling' }
  | { kind: 'help' }
  | { kind: 'clarify'; question: string; draft?: ClarificationDraft }
  | { kind: 'unknown' };

export interface InterpretContext {
  /** Original receipt time of the message — relative dates resolve against this, not processing time. */
  receivedAt: Date;
  timezone: string;
  locale: 'uz' | 'en' | 'ru';
}
