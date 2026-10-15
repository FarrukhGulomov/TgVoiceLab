import type { Intent, InterpretContext, TaskRef } from '../../application/intent.js';
import type { TextInterpreterPort } from '../../application/ports.js';
import { t } from './i18n.js';
import { extractWhen, normalizeApostrophes, type ParsedWhen } from './nl-datetime.js';

const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  birinchi: 1, ikkinchi: 2, uchinchi: 3, "to'rtinchi": 4, beshinchi: 5, oltinchi: 6, yettinchi: 7, sakkizinchi: 8, "to'qqizinchi": 9, "o'ninchi": 10,
};
const ORD = Object.keys(ORDINALS).map((k) => k.replace(/'/g, "'")).join('|');
export const DEFAULT_TASK_DUE_TIME = '18:00'; // a date-only task deadline means end of the working day; always echoed back

function findRef(s: string, noun: 'task' | 'reminder' | 'any'): TaskRef | null {
  const nounRe = noun === 'task' ? 'task|vazifa(?:ni|ga)?' : noun === 'reminder' ? 'reminder|eslatma(?:ni|ga)?' : 'task|reminder|vazifa(?:ni|ga)?|eslatma(?:ni|ga)?';
  const ordW = new RegExp(`\\b(${ORD})\\b`, 'i').exec(s);
  if (ordW) return { by: 'ordinal', n: ORDINALS[ordW[1]!.toLowerCase()]! };
  const num = new RegExp(`(?:#|\\bno\\.?\\s*|\\b(?:${nounRe})\\s+)(\\d{1,3})\\b|\\b(\\d{1,3})(?:st|nd|rd|th)\\b|\\b(\\d{1,3})\\s*-?\\s*(?:${nounRe})\\b|(?:^|\\s)(\\d{1,3})\\s*-\\s*(?:chi)?\\b`, 'i').exec(s);
  const n = num && (num[1] ?? num[2] ?? num[3] ?? num[4]);
  if (n) return { by: 'ordinal', n: +n };
  // "done 2", "complete #2": a bare number directly after the verb.
  const bare = /\b(?:done|complete[d]?|finish(?:ed)?)\s+(?:task\s+)?#?(\d{1,3})\b/i.exec(s);
  if (bare) return { by: 'ordinal', n: +bare[1]! };
  return null;
}

const toDue = (w: ParsedWhen, taskDefaultTime = false) => (w.date ? { date: w.date, time: w.time ?? (taskDefaultTime ? DEFAULT_TASK_DUE_TIME : '') } : undefined);

function clarifyWhen(w: ParsedWhen, ctx: InterpretContext): Intent | null {
  if (w.invalid) return { kind: 'clarify', question: t(ctx.locale, 'unknown') };
  if (w.ambiguousHour !== undefined)
    return { kind: 'clarify', question: t(ctx.locale, 'ambiguous_time', { hour: w.ambiguousHour, hour24: w.ambiguousHour + 12 }) };
  return null;
}

const clean = (s: string) => s.replace(/^[\s,:;.\-–—]+|[\s,:;.\-–—]+$/g, '').replace(/^(?:to|that|about|ni|nima)\s+/i, '').trim();

/**
 * Deterministic interpreter for en/uz. Anything it cannot place confidently becomes `clarify` or `unknown` — it never
 * guesses an action. Russian is not covered by the rules adapter (returns unknown); use an LLM adapter for broader input.
 */
export class RulesInterpreter implements TextInterpreterPort {
  async interpret(raw: string, ctx: InterpretContext): Promise<Intent> {
    const text = normalizeApostrophes(raw).trim();
    const low = text.toLowerCase();
    if (!text) return { kind: 'unknown' };

    if (/^\/?(?:help|start|yordam)\b/.test(low)) return { kind: 'help' };
    if (/\b(?:stop\s+calling(?:\s+me)?|(?:do\s*n'?t|do\s+not)\s+call\s+me|qo'ng'iroq\s+qilma(?:ng)?|qong'iroq\s+qilma(?:ng)?)\b/.test(low)) return { kind: 'stop_calling' };

    if (/^(?:\/tasks|(?:my|list|show)(?:\s+(?:my|all|open))*\s+tasks?|what(?:'s|\s+are)\s+my\s+tasks|tasks?|vazifalarim|vazifalar(?:\s+ro'yxati)?|vazifalarni\s+ko'rsat)\??$/.test(low)) return { kind: 'list_tasks' };
    if (/^(?:\/reminders|(?:my|list|show)(?:\s+(?:my|all|active))*\s+reminders?|reminders?|eslatmalarim|eslatmalar(?:\s+ro'yxati)?|eslatmalarni\s+ko'rsat)\??$/.test(low)) return { kind: 'list_reminders' };

    // cancel reminder
    if (/\b(?:cancel|delete|remove)\b.*\breminder\b|\beslatma(?:ni)?\b.*\b(?:bekor|o'chir)/.test(low)) {
      const ref = findRef(low, 'reminder');
      return ref ? { kind: 'cancel_reminder', ref } : { kind: 'clarify', question: t(ctx.locale, 'ref_unresolved') };
    }

    // complete task
    if (/\b(?:done|complete[d]?|finish(?:ed)?|bajarildi|tugadi|bajardim)\b/.test(low) && !/\bremind/.test(low)) {
      const ref = findRef(low, 'task');
      if (ref) return { kind: 'complete_task', ref };
      const m = /(?:done|complete[d]?|finish(?:ed)?)[:\s]+(.+)/i.exec(text);
      return m?.[1] ? { kind: 'complete_task', ref: { by: 'text', text: clean(m[1]) } } : { kind: 'clarify', question: t(ctx.locale, 'ref_unresolved') };
    }

    // move / reschedule
    if (/\b(?:move|reschedule|postpone|push|ko'chir|surish|surib\s+qo'y)\w*/.test(low)) {
      const isReminder = /\breminder\b|\beslatma/.test(low);
      const w = extractWhen(text, ctx);
      const amb = clarifyWhen(w, ctx);
      if (amb) return amb;
      const ref = findRef(low, isReminder ? 'reminder' : 'task');
      if (!ref) return { kind: 'clarify', question: t(ctx.locale, 'ref_unresolved') };
      if (!w.date) return { kind: 'clarify', question: t(ctx.locale, 'unknown') };
      if (!w.time && isReminder) return { kind: 'clarify', question: t(ctx.locale, 'ask_time', { date: w.date }) };
      return isReminder
        ? { kind: 'reschedule_reminder', ref, at: { date: w.date, time: w.time! } }
        : { kind: 'reschedule_task', ref, due: { date: w.date, time: w.time ?? DEFAULT_TASK_DUE_TIME } };
    }

    // create reminder
    if (/\bremind\b|\breminder\b|\beslat/.test(low)) {
      const w = extractWhen(text, ctx);
      const amb = clarifyWhen(w, ctx);
      if (amb) return amb;
      let title = w.rest;
      title = title.replace(/\b(?:please\s+)?remind\s+me\b/i, ' ').replace(/\breminder\s*[:\-]?/i, ' ')
        .replace(/(\S+?)ni\s+eslat\w*(?:ib\s+qo'y)?\w*/i, '$1').replace(/\beslat\w*(?:ib\s+qo'y)?\w*/i, ' ');
      title = clean(title);
      if (!title) return { kind: 'clarify', question: t(ctx.locale, 'ask_reminder_text') };
      if (!w.date) return { kind: 'clarify', question: t(ctx.locale, 'unknown') };
      if (!w.time) return { kind: 'clarify', question: t(ctx.locale, 'ask_time', { date: w.date }) };
      return { kind: 'create_reminder', title, at: { date: w.date, time: w.time }, ...(w.recurrence ? { recurrence: w.recurrence } : {}) };
    }

    // create task
    const taskTrigger = /^(?:\/task\b|(?:add|create|new)\s+(?:a\s+)?task\b|task\s*[:\-]|todo\s*[:\-]?|vazifa\s*(?:qo'sh\w*)?\s*[:\-]?)|\bvazifa\s+qo'sh\w*/i;
    if (taskTrigger.test(text)) {
      const w = extractWhen(text, ctx);
      const amb = clarifyWhen(w, ctx);
      if (amb) return amb;
      const title = clean(w.rest.replace(taskTrigger, ' ').replace(/\b(?:due|by|until|muddati)\b/gi, ' '));
      if (!title) return { kind: 'clarify', question: t(ctx.locale, 'ask_task_title') };
      const due = toDue(w, true);
      return { kind: 'create_task', title, ...(due ? { due } : {}) };
    }

    return { kind: 'unknown' };
  }
}
