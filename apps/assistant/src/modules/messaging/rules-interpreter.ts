import { DateTime } from 'luxon';
import type { ClarificationDraft, Intent, InterpretContext, ReminderDraft, TaskRef } from '../../application/intent.js';
import type { TextInterpreterPort } from '../../application/ports.js';
import { t } from './i18n.js';
import { extractWhen, normalizeApostrophes, type ParsedWhen } from './nl-datetime.js';

const ORDINALS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  birinchi: 1,
  ikkinchi: 2,
  uchinchi: 3,
  "to'rtinchi": 4,
  beshinchi: 5,
  oltinchi: 6,
  yettinchi: 7,
  sakkizinchi: 8,
  "to'qqizinchi": 9,
  "o'ninchi": 10,
};
const ORD = Object.keys(ORDINALS)
  .map((k) => k.replace(/'/g, "'"))
  .join('|');
export const DEFAULT_TASK_DUE_TIME = '18:00'; // a date-only task deadline means end of the working day; always echoed back

function findRef(s: string, noun: 'task' | 'reminder' | 'any'): TaskRef | null {
  const nounRe =
    noun === 'task' ? 'task|vazifa(?:ni|ga)?' : noun === 'reminder' ? 'reminder|eslatma(?:ni|ga)?' : 'task|reminder|vazifa(?:ni|ga)?|eslatma(?:ni|ga)?';
  const ordW = new RegExp(`\\b(${ORD})\\b`, 'i').exec(s);
  if (ordW) return { by: 'ordinal', n: ORDINALS[ordW[1]!.toLowerCase()]! };
  const num = new RegExp(
    `(?:#|\\bno\\.?\\s*|\\b(?:${nounRe})\\s+)(\\d{1,3})\\b|\\b(\\d{1,3})(?:st|nd|rd|th)\\b|\\b(\\d{1,3})\\s*-?\\s*(?:${nounRe})\\b|(?:^|\\s)(\\d{1,3})\\s*-\\s*(?:chi)?\\b`,
    'i',
  ).exec(s);
  const n = num && (num[1] ?? num[2] ?? num[3] ?? num[4]);
  if (n) return { by: 'ordinal', n: +n };
  // "done 2", "complete #2": a bare number directly after the verb.
  const bare = /\b(?:done|complete[d]?|finish(?:ed)?)\s+(?:task\s+)?#?(\d{1,3})\b/i.exec(s);
  if (bare) return { by: 'ordinal', n: +bare[1]! };
  return null;
}

const toDue = (w: ParsedWhen, taskDefaultTime = false) =>
  w.date ? { date: w.date, time: w.time ?? (taskDefaultTime ? DEFAULT_TASK_DUE_TIME : '') } : undefined;

function clarifyWhen(w: ParsedWhen, ctx: InterpretContext, draftBase?: Omit<ReminderDraft, 'missing' | 'ambiguousHour'>): Intent | null {
  if (w.invalid) return { kind: 'clarify', question: t(ctx.locale, 'unknown') };
  if (w.ambiguousHour !== undefined)
    return {
      kind: 'clarify',
      question: t(ctx.locale, 'ambiguous_time', { hour: w.ambiguousHour, hour24: w.ambiguousHour + 12 }),
      ...(draftBase ? { draft: { ...draftBase, missing: 'ambiguous_time' as const, ambiguousHour: w.ambiguousHour } } : {}),
    };
  return null;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const EVENING = /^(?:in the )?(?:evening|pm|tonight|kechqurun|kechki|kechasi|вечером|вечер)$/;
const MORNING = /^(?:in the )?(?:morning|am|ertalab|ertalabgi|утром|утра)$/;
const TIME_ONLY = /^(?:at\s+|soat\s+|в\s+)?\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?(?:\s*(?:da|dan|ga))?$/;
const today = (ctx: InterpretContext) => DateTime.fromJSDate(ctx.receivedAt, { zone: ctx.timezone }).toFormat('yyyy-LL-dd');

const NEGATION_EN =
  /\b(?:not|no(?!\.?\s*\d)|never|don'?t|doesn'?t|didn'?t|isn'?t|aren'?t|wasn'?t|haven'?t|hasn'?t|won'?t|can'?t|cannot|without|ignore|mistake)\b/;
const NEGATION_UZ =
  /\b(?:emas|yo'q|yoq|aslo|hech|demadim|demang|\w+(?:ma|may)(?:di|dim|dik|ding|dingiz|ng|ngiz|sin|sinlar|yman)|\w*(?:qil|chir|bajar|tugat|sur)ma)\b/;
const QUOTED = /["“”«»`]/;
const QUESTION_START = /^(?:should|can|could|would|will|do|does|did|is|are|what|why|how|e\.g\.|for example|say|masalan)\b/;

/**
 * Audit F01: destructive intents (complete / cancel / move) must come from a clearly affirmative, plain command.
 * Negation, questions, quoted examples and descriptive/mixed clauses are never executed: the caller asks for an explicit command.
 */
function notAnExplicitCommand(text: string, low: string): boolean {
  return NEGATION_EN.test(low) || NEGATION_UZ.test(low) || QUOTED.test(text) || /\?\s*$/.test(text) || QUESTION_START.test(low) || /\bmi\s*$/.test(low);
}

const clean = (s: string) =>
  s
    .replace(/^[\s,:;.\-–—]+|[\s,:;.\-–—]+$/g, '')
    .replace(/^(?:to|that|about|ni|nima)\s+/i, '')
    .trim();

/**
 * Deterministic interpreter for en/uz. Anything it cannot place confidently becomes `clarify` or `unknown` — it never
 * guesses an action. Russian is not covered by the rules adapter (returns unknown); use an LLM adapter for broader input.
 */
// Spoken/typed variants of "qo'ng'iroq" the owner actually writes (qungiroq, qongiroq, qungriqo, ...), plus "ovozli call(da)".
const UZ_CALL = "(?:qo'?ng'?iroq|qo'?ng'?roq|qu?ng'?iroq|qong'?iroq|qung'?riqo|zvonok)";
const BY_CALL_SRC = `\\b${UZ_CALL}\\s*(?:qilib|qiling|qil|bilan|orqali)(?![\\p{L}'])|\\bovozli\\s+(?:call|${UZ_CALL})\\w*|\\bcall\\s+qil(?:ib|ing)?(?![\\p{L}'])|telefon\\s+qilib|\\b(?:call|phone|ring)\\s+me\\b|\\bby\\s+(?:call|phone)\\b`;
const BY_CALL = new RegExp(BY_CALL_SRC, 'u');
const BY_CALL_G = new RegExp(BY_CALL_SRC, 'giu');

export class RulesInterpreter implements TextInterpreterPort {
  /**
   * Finish a pending reminder with the owner's next message. Only a short, time-shaped reply counts ("17:00", "5 pm", "evening");
   * anything else returns null so an unrelated message can never silently complete (or be mistaken for) the answer.
   */
  async completeDraft(raw: string, draft: ClarificationDraft, ctx: InterpretContext): Promise<Intent | null> {
    const low = normalizeApostrophes(raw).trim().toLowerCase();
    if (!low || low.length > 40) return null;
    let time: string | undefined;
    if (draft.missing === 'ambiguous_time' && draft.ambiguousHour !== undefined) {
      const h = draft.ambiguousHour;
      if (EVENING.test(low) && h + 12 <= 23) time = `${pad2(h + 12)}:00`;
      else if (MORNING.test(low)) time = `${pad2(h)}:00`;
    }
    if (!time && TIME_ONLY.test(low)) {
      const w = extractWhen(low, ctx);
      if (!w.invalid && w.ambiguousHour === undefined && w.time) time = w.time;
    }
    if (!time) return null;
    return {
      kind: 'create_reminder',
      title: draft.title,
      at: { date: draft.date, time },
      ...(draft.recurrence ? { recurrence: draft.recurrence } : {}),
      ...(draft.byCall ? { byCall: true } : {}),
    };
  }

  async interpret(raw: string, ctx: InterpretContext): Promise<Intent> {
    const text = normalizeApostrophes(raw).trim();
    const low = text.toLowerCase();
    if (!text) return { kind: 'unknown' };

    if (/^\/?(?:help|start|yordam)\b/.test(low)) return { kind: 'help' };
    if (/\b(?:stop\s+calling(?:\s+me)?|(?:do\s*n'?t|do\s+not)\s+call\s+me|qo'ng'iroq\s+qilma(?:ng)?|qong'iroq\s+qilma(?:ng)?)\b/.test(low))
      return { kind: 'stop_calling' };

    // ---- contacts and calls to contacts (the owner's explicit commands) ---------------------------------------------------
    {
      const add = /^(?:(?:add|new)\s+contact|kontakt\s+qo'sh(?:ing)?)\s*:?\s+(.+?)\s+(\d{5,19})\s*$/i.exec(text);
      if (add) return { kind: 'add_contact', name: clean(add[1]!), telegramUserId: add[2]! };
      // No numeric id needed: a @username or a +phone is resolved through Telegram; a bare name asks how to identify the person.
      const addBy = /^(?:(?:add|new)\s+contact|kontakt\s+qo'sh(?:ing)?)\s*:?\s+(?:(.+?)\s+)?(@[A-Za-z][A-Za-z0-9_]{3,31}|\+\d[\d\s-]{7,16}\d)\s*$/i.exec(text);
      if (addBy) {
        const id = addBy[2]!;
        return {
          kind: 'lookup_contact',
          name: clean(addBy[1] ?? ''),
          ...(id.startsWith('@') ? { username: id.slice(1) } : { phone: id.replace(/[\s-]/g, '') }),
        };
      }
      if (/^(?:(?:add|new)\s+contact|kontakt\s+qo'sh(?:ing)?)\s*:?\s+\S.*$/i.test(text)) return { kind: 'clarify', question: t(ctx.locale, 'contact_how') };
      const del = /^(?:(?:remove|delete)\s+contact|kontakt(?:ni)?\s+(?:o'chir|olib\s+tashla)\w*)\s*:?\s+(.+)$/i.exec(text);
      if (del) {
        if (notAnExplicitCommand(text, low)) return { kind: 'clarify', question: t(ctx.locale, 'not_a_command') };
        return { kind: 'remove_contact', name: clean(del[1]!) };
      }
      if (/^(?:contacts?|kontaktlar(?:im)?|\/contacts)\??$/i.test(low)) return { kind: 'list_contacts' };
      const nm = /^(?:my\s+name\s+is|mening\s+ismim|ismim)\s*:?\s+(.{1,80})$/i.exec(text);
      if (nm) return { kind: 'set_owner_name', name: clean(nm[1]!) };
      // "Javlonga ertaga 10:00 da qo'ng'iroq qilib hisobot tayyorligini ayt"  /  "call Javlon tomorrow at 10:00 and tell him the report is ready".
      // Date/time words are taken out FIRST, so "ertaga" is never mistaken for a name. Only the imperative/converb forms (qil, qilib, qiling,
      // call) count: "qilaman", "qilishni eslat", "remind me to call" are statements or reminders and never ring anyone.
      // A meeting proposal lists times AFTER the call phrase ("... qo'ng'iroq qilib uchrashuv taklif qil: 15:00 yoki 17:00"). Those are offered
      // slots, not the time of the call, so only the part BEFORE the call phrase is searched for the call's own date and time.
      const callAt = normalizeApostrophes(text).search(new RegExp(`${UZ_CALL}\\s+qil|\\bcall\\s+\\S+\\s`, 'iu'));
      const meetingTalk = callAt >= 0 && /uchrashuv|учраш|meeting|meet\b|ko'rish/i.test(normalizeApostrophes(text).slice(callAt));
      const head = meetingTalk ? text.slice(0, callAt) : text;
      const tail = meetingTalk ? text.slice(callAt) : '';
      const w0 = extractWhen(head, ctx);
      const body = meetingTalk ? `${w0.rest} ${tail}`.trim() : w0.rest;
      const uz = new RegExp(`^(\\S+?)(?:\\s+degan\\s+kontakt\\w*|(?:ga|ka|qa))\\s+(.*?)${UZ_CALL}\\s+qil(?:ib|ing)?(?![\\p{L}'])[:,]?\\s*(.*)$`, 'iu').exec(
        body,
      );
      const en = /^(?:please\s+)?call\s+(?!me\b|qil)(\S+)(?:\s+(.*))?$/i.exec(body);
      const NOT_NAMES = /^(?:men|me|sen|sizga?|menga|senga|unga|bizga|ularga|ertaga|bugun|indinga|kecha|hozir|kimga|nimaga|bunga|shunga)$/i;
      const who = uz ? body.split(/\s+/)[0]! : en ? en[1]! : '';
      if ((uz || en) && !NOT_NAMES.test(who)) {
        if (w0.invalid) return { kind: 'clarify', question: t(ctx.locale, 'unknown') };
        const amb = clarifyWhen(w0, ctx);
        if (amb) return amb;
        const said = uz ? `${uz[2] ?? ''} ${uz[3] ?? ''}` : (en![2] ?? '');
        const message = clean(
          said.replace(/^\s*(?:and\s+)?(?:tell|ask|remind|say\s+to)\s+(?:him|her|them)\s*(?:that|to)?\s*/i, '').replace(/^\s*(?:and|va)\s+/i, ''),
        );
        if (!message) return { kind: 'clarify', question: t(ctx.locale, 'ask_call_message', { name: who }) };
        if (w0.date && !w0.time && !meetingTalk) return { kind: 'clarify', question: t(ctx.locale, 'ask_time', { date: w0.date }) };
        // A meeting proposal: "... uchrashuv taklif qil: 15:00 yoki 17:00". The offered times (on the call's date, else today) are the ONLY
        // times the AI may agree to on the owner's behalf.
        const slots: Array<{ date: string; time: string }> = [];
        if (meetingTalk) {
          // The date comes from date WORDS in the tail ("ertaga ...") only; bare times would otherwise default to today.
          const day = extractWhen(tail.replace(/\b(?:[01]?\d|2[0-3])[:.][0-5]\d\b/g, ' '), ctx).date ?? w0.date ?? today(ctx);
          for (const m of tail.matchAll(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/g)) {
            const time = `${m[1]!.padStart(2, '0')}:${m[2]}`;
            if (!slots.some((x) => x.time === time)) slots.push({ date: day, time });
          }
        }
        return {
          kind: 'call_contact',
          contact: who,
          message,
          ...(w0.date && w0.time ? { at: { date: w0.date, time: w0.time } } : {}),
          ...(slots.length ? { slots: slots.slice(0, 5) } : {}),
        };
      }
    }

    // daily briefing: "daily briefing at 8", "brief me every day at 08:30", "har kuni soat 8 da brifing", "brifingni o'chir"
    // A reminder/task that merely MENTIONS a briefing ("remind me to prepare the briefing at 9") is not a briefing command.
    if (/\b(?:briefing|brief\s+me|brifing\w*)\b/.test(low) && !/\b(?:remind\w*|reminder|task|todo|vazifa\w*|eslat\w*)\b/.test(low)) {
      if (/\b(?:cancel|stop|disable|remove|delete|turn\s+off|o'chir\w*|bekor|to'xtat\w*)\b/.test(low)) {
        if (notAnExplicitCommand(text, low)) return { kind: 'clarify', question: t(ctx.locale, 'not_a_command') };
        return { kind: 'cancel_briefing' };
      }
      const w = extractWhen(text, ctx);
      const amb = clarifyWhen(w, ctx);
      if (amb) return amb;
      if (!w.time) return { kind: 'clarify', question: t(ctx.locale, 'briefing_ask_time') };
      return { kind: 'set_briefing', time: w.time };
    }

    if (
      /^(?:\/tasks|(?:my|list|show)(?:\s+(?:my|all|open))*\s+tasks?|what(?:'s|\s+are)\s+my\s+tasks|tasks?|vazifalarim|vazifalar(?:\s+ro'yxati)?|vazifalarni\s+ko'rsat)\??$/.test(
        low,
      )
    )
      return { kind: 'list_tasks' };
    if (
      /^(?:\/reminders|(?:my|list|show)(?:\s+(?:my|all|active))*\s+reminders?|reminders?|eslatmalarim|eslatmalar(?:\s+ro'yxati)?|eslatmalarni\s+ko'rsat)\??$/.test(
        low,
      )
    )
      return { kind: 'list_reminders' };

    // cancel reminder
    if (/\b(?:cancel|delete|remove)\b.*\breminder\b|\beslatma(?:ni)?\b.*\b(?:bekor|o'chir)/.test(low)) {
      if (notAnExplicitCommand(text, low)) return { kind: 'clarify', question: t(ctx.locale, 'not_a_command') };
      const ref = findRef(low, 'reminder');
      return ref ? { kind: 'cancel_reminder', ref } : { kind: 'clarify', question: t(ctx.locale, 'ref_unresolved') };
    }

    // complete task
    if (/\b(?:done|complete[d]?|finish(?:ed)?|bajarildi|tugadi|bajardim)\b/.test(low) && !/\bremind/.test(low)) {
      if (notAnExplicitCommand(text, low)) return { kind: 'clarify', question: t(ctx.locale, 'not_a_command') };
      const ref = findRef(low, 'task');
      if (ref) return { kind: 'complete_task', ref };
      const m = /(?:done|complete[d]?|finish(?:ed)?)[:\s]+(.+)/i.exec(text);
      return m?.[1] ? { kind: 'complete_task', ref: { by: 'text', text: clean(m[1]) } } : { kind: 'clarify', question: t(ctx.locale, 'ref_unresolved') };
    }

    // move / reschedule
    if (/\b(?:move|reschedule|postpone|push|ko'chir|surish|surib\s+qo'y)\w*/.test(low)) {
      if (notAnExplicitCommand(text, low)) return { kind: 'clarify', question: t(ctx.locale, 'not_a_command') };
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
    if (/\bremind\b|\breminder\b|\beslat/.test(low) || (BY_CALL.test(low) && /\b(?:ayt|xabar\s+ber)\w*/.test(low))) {
      // "remind me BY CALL" / "qo'ng'iroq qilib eslat": the owner's explicit wish to be rung. The phrase is not part of the title.
      const byCall = BY_CALL.test(low);
      const w = extractWhen(byCall ? text.replace(BY_CALL_G, ' ') : text, ctx);
      let title = w.rest;
      title = title
        .replace(/\b(?:please\s+)?remind\s+me\b/i, ' ')
        .replace(/\breminder\s*[:-]?/i, ' ')
        .replace(/(\S+?)ni\s+eslat\w*(?:ib\s+qo'y)?\w*/i, '$1')
        .replace(/\beslat\w*(?:ib\s+qo'y)?\w*/i, ' ')
        .replace(/\b(?:menga|manga)\b/i, ' ')
        .replace(/^\s*va\s+/i, ' ')
        .replace(/\b(?:ayt(?:ing)?|xabar\s+ber(?:ing)?)\b/i, ' ');
      title = clean(title);
      const base = title
        ? {
            kind: 'create_reminder' as const,
            title,
            date: w.date ?? today(ctx),
            ...(w.recurrence ? { recurrence: w.recurrence } : {}),
            ...(byCall ? { byCall: true } : {}),
          }
        : undefined;
      const amb = clarifyWhen(w, ctx, base);
      if (amb) return amb;
      if (!title) return { kind: 'clarify', question: t(ctx.locale, 'ask_reminder_text') };
      if (!w.date) return { kind: 'clarify', question: t(ctx.locale, 'unknown') };
      if (!w.time)
        return {
          kind: 'clarify',
          question: t(ctx.locale, 'ask_time', { date: w.date }),
          draft: {
            kind: 'create_reminder',
            title,
            date: w.date,
            missing: 'time',
            ...(w.recurrence ? { recurrence: w.recurrence } : {}),
            ...(byCall ? { byCall: true } : {}),
          },
        };
      return {
        kind: 'create_reminder',
        title,
        at: { date: w.date, time: w.time },
        ...(w.recurrence ? { recurrence: w.recurrence } : {}),
        ...(byCall ? { byCall: true } : {}),
      };
    }

    // create task
    const taskTrigger = /^(?:\/task\b|(?:add|create|new)\s+(?:a\s+)?task\b|task\s*[:-]|todo\s*[:-]?|vazifa\s*(?:qo'sh\w*)?\s*[:-]?)|\bvazifa\s+qo'sh\w*/i;
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
