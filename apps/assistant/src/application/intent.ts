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
  | { kind: 'clarify'; question: string }
  | { kind: 'unknown' };

export interface InterpretContext {
  /** Original receipt time of the message — relative dates resolve against this, not processing time. */
  receivedAt: Date;
  timezone: string;
  locale: 'uz' | 'en' | 'ru';
}
