import { DateTime } from 'luxon';
import type { Queryable } from '../../infrastructure/db/db.js';
import type { Task, TaskService } from '../tasks/tasks.service.js';
import { t, type Locale } from './i18n.js';

const MAX_PER_SECTION = 10;

export interface Briefing {
  text: string;
  /** Task ids in the order they are numbered in the text: "done 2" / "move 2 to tomorrow" resolve against this snapshot. */
  taskIds: string[];
}

/**
 * Deterministic daily briefing (no model): overdue tasks, then tasks due on the briefing's local day. The day is the day the briefing
 * was SCHEDULED for, so a briefing delayed by an outage still describes the right day. Open tasks only.
 */
export async function composeBriefing(a: {
  q: Queryable;
  tasks: TaskService;
  ownerId: string;
  locale: Locale;
  timezone: string;
  scheduledAt: Date;
}): Promise<Briefing> {
  const day = DateTime.fromJSDate(a.scheduledAt, { zone: a.timezone });
  const start = day.startOf('day');
  const end = day.endOf('day');
  const open = await a.tasks.list(a.q, a.ownerId, { limit: 200 });
  const at = (x: Task) => DateTime.fromISO(x.dueAt!, { zone: a.timezone });
  const overdue = open.filter((x) => x.dueAt && at(x) < start);
  const today = open.filter((x) => x.dueAt && at(x) >= start && at(x) <= end);

  const lines: string[] = [t(a.locale, 'briefing_header', { date: day.toFormat('yyyy-LL-dd') })];
  const ids: string[] = [];
  const section = (headerKey: 'briefing_overdue' | 'briefing_today', items: Task[], fmt: (x: Task) => string) => {
    if (!items.length) return;
    lines.push('', t(a.locale, headerKey));
    for (const x of items.slice(0, MAX_PER_SECTION)) {
      ids.push(x.id);
      lines.push(`${ids.length}. ${x.title} — ${fmt(x)}`);
    }
    if (items.length > MAX_PER_SECTION) lines.push(t(a.locale, 'briefing_more', { n: items.length - MAX_PER_SECTION }));
  };
  section('briefing_overdue', overdue, (x) => at(x).toFormat('yyyy-LL-dd HH:mm'));
  section('briefing_today', today, (x) => at(x).toFormat('HH:mm'));
  if (!ids.length) lines.push('', t(a.locale, 'briefing_empty'));
  else lines.push('', t(a.locale, 'briefing_hint'));
  return { text: lines.join('\n'), taskIds: ids };
}
