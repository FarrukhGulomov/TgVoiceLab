import type { CallEndReason } from '@tgvl/contracts';
import type { Db } from '../../../infrastructure/db/db.js';
import type { Clock } from '../../../application/clock.js';
import type { TaskService } from '../../tasks/tasks.service.js';
import type { ReminderService } from '../../scheduling/reminders.service.js';
import type { CallSessionRunner } from '../orchestrator.js';
import { RealtimeCallBridge, type RealtimeLink, type ToolDeclaration } from '../audio/realtime-bridge.js';
import { OWNER_CALL_TOOL_DECLARATIONS, OwnerCallTools, buildOwnerCallInstructions } from './owner-call-tools.js';

export interface OwnerCallRunnerDeps {
  db: Db;
  tasks: TaskService;
  reminders: ReminderService;
  clock: Clock;
  /** Opens one AI voice session (OpenAI Realtime / Gemini Live) for this call. */
  makeLink(a: { instructions: string; tools: ToolDeclaration[] }): RealtimeLink;
  /** True when a reminder set `by_call` will really ring (calling enabled). Told to the model so it never over-promises. */
  callRemindersLive: boolean;
  /** Estimated provider cost, used only to settle the call budget. Unset => settles 0 (documented gap). */
  costUsdPerMinute?: number | undefined;
  log?: ((line: string) => void) | undefined;
}

const GREETING_BRIEFING = "Qo'ng'iroqqa hozir javob berildi. Brifingni boshla: o'zingni tanishtir va vazifalarni qisqa o'qib ber.";
const GREETING_REMINDER = "Qo'ng'iroqqa hozir javob berildi. O'zingni AI yordamchi deb tanishtir va eslatmani ayt.";

/**
 * The conversation layer for calls TO THE OWNER: an AI voice session with the owner's task tools. Contact calls get no conversation
 * (consent, disclosure and the contact tool set are not built), so the call ends at once exactly as without a runner.
 */
export class OwnerCallRunner implements CallSessionRunner {
  constructor(private readonly d: OwnerCallRunnerDeps) {}

  async run(ctx: Parameters<CallSessionRunner['run']>[0]): Promise<{ endReason: CallEndReason; usageMicroUsd?: number }> {
    const { ownerId, plan, handle } = ctx;
    const { db } = this.d;
    const owner = (await db.query<{ timezone: string; telegram_user_id: string }>('SELECT timezone, telegram_user_id FROM owners WHERE id=$1', [ownerId]))
      .rows[0];
    // Defence in depth: the orchestrator classified the call already; this layer talks only to the authenticated owner.
    if (!owner || owner.telegram_user_id !== plan.recipientTelegramId) return { endReason: 'cancelled' };

    let endRequested!: () => void;
    const endAsked = new Promise<void>((r) => (endRequested = r));
    const tools = new OwnerCallTools({
      db,
      tasks: this.d.tasks,
      reminders: this.d.reminders,
      clock: this.d.clock,
      ownerId,
      timezone: owner.timezone,
      callRemindersLive: this.d.callRemindersLive,
      onEndCall: () => endRequested(),
    });
    await tools.load();
    const reminder = plan.topic === 'reminder' ? (plan.allowedContext[0] ?? undefined) : undefined;
    const instructions = buildOwnerCallInstructions({
      now: this.d.clock.now(),
      timezone: owner.timezone,
      tasks: tools.describeList(),
      ...(reminder ? { reminder } : {}),
    });
    const link = this.d.makeLink({ instructions, tools: OWNER_CALL_TOOL_DECLARATIONS });
    const bridge = new RealtimeCallBridge(handle, link, { ...(this.d.log ? { log: this.d.log } : {}), onTool: (c) => tools.execute(c) });
    const started = Date.now();
    bridge.start(reminder ? GREETING_REMINDER : GREETING_BRIEFING);

    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<'limit'>((r) => (timer = setTimeout(() => r('limit'), plan.maxDurationSeconds * 1000)));
    const why = await Promise.race([endAsked.then(() => 'end' as const), bridge.finished.then(() => 'over' as const), limit]);
    clearTimeout(timer);
    bridge.stop();
    const seconds = (Date.now() - started) / 1000;
    const usageMicroUsd = this.d.costUsdPerMinute ? Math.round((seconds / 60) * this.d.costUsdPerMinute * 1_000_000) : undefined;
    return { endReason: why === 'limit' ? 'duration_limit' : 'completed', ...(usageMicroUsd !== undefined ? { usageMicroUsd } : {}) };
  }
}
