import type { RecallService } from '../../memory/recall.js';
import { answeredEarlierToday } from './daily.js';
import { OWNER_CALLED_IN, OWNER_REQUESTED_CALL } from '../../../application/intent.js';
import type { CallEndReason } from '@tgvl/contracts';
import type { Db } from '../../../infrastructure/db/db.js';
import type { Clock } from '../../../application/clock.js';
import type { TaskService } from '../../tasks/tasks.service.js';
import type { ReminderService } from '../../scheduling/reminders.service.js';
import type { ContactService } from '../../contacts/contacts.service.js';
import type { ContactCallService } from '../contact-calls.service.js';
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
  contacts?: ContactService | undefined;
  contactCalls?: ContactCallService | undefined;
  recall?: RecallService | undefined;
  /** Estimated provider cost, used only to settle the call budget. Unset => a connected call is settled at its full reservation. */
  costUsdPerMinute?: number | undefined;
  /** The owner's first name (OWNER_NAME); unset: no name is spoken. */
  ownerName?: string | undefined;
  log?: ((line: string) => void) | undefined;
  /** Put what was said and tool arguments into log lines (development only). */
  logContent?: boolean | undefined;
}

const NO_SELF_INTRO = "O'zingni tanishtirma (egasi seni biladi), 'men sizning yordamchingizman' dema.";
const withName = (name: string | undefined, phrase: string): string => (name ? `${name}, ${phrase}` : phrase.charAt(0).toUpperCase() + phrase.slice(1));
const greet = (first: boolean): string =>
  (first ? "Qisqa salom ber (bitta jumla), keyin darrov maqsadga o't. " : "Bugun allaqachon gaplashgansiz: SALOM BERMA, darrov maqsadga o't. ") + NO_SELF_INTRO;
const GREETING_BRIEFING = (first: boolean): string => `Qo'ng'iroqqa hozir javob berildi. ${greet(first)} Vazifalarni qisqa o'qib ber.`;
const GREETING_ASKED = (first: boolean, name?: string): string =>
  `Qo'ng'iroqqa hozir javob berildi. Egasining o'zi qo'ng'iroq so'ragan. ${greet(first)} '${withName(name, 'sizga biror topshiriq bormi?')}' de. Eslatma haqida gapirma.`;
const NUDGE = (name?: string): string =>
  `Egasi indamayapti. Qisqa qilib, bir jumlada so'ra: '${withName(name, 'eshityapsizmi?')} Sizga biror topshiriq bormi?' Boshqa narsa dema.`;
const GREETING_INBOUND = (first: boolean, name?: string): string =>
  `Egasining o'zi senga qo'ng'iroq qildi va sen javob berding. ${first ? `Qisqa javob ber (bitta jumla): 'Labbay, ${name ? `${name}, ` : ''}eshitaman.'` : "Bugun allaqachon gaplashgansiz: SALOM BERMA, faqat qisqa 'Eshitaman' de."} ${NO_SELF_INTRO} Keyin egasini tinglab, topshirig'ini kut; o'zing mavzu boshlama.`;
const GREETING_REMINDER = (first: boolean): string => `Qo'ng'iroqqa hozir javob berildi. ${greet(first)} Eslatmani ayt.`;

/**
 * The conversation layer for calls TO THE OWNER: an AI voice session with the owner's task tools. Contact calls get no conversation
 * (consent, disclosure and the contact tool set are not built), so the call ends at once exactly as without a runner.
 */
export class OwnerCallRunner implements CallSessionRunner {
  constructor(private readonly d: OwnerCallRunnerDeps) {}

  async run(ctx: Parameters<CallSessionRunner['run']>[0]): Promise<{ endReason: CallEndReason; usageMicroUsd?: number; conversationHeld?: boolean }> {
    const { ownerId, plan, handle } = ctx;
    const { db } = this.d;
    const owner = (await db.query<{ timezone: string; telegram_user_id: string }>('SELECT timezone, telegram_user_id FROM owners WHERE id=$1', [ownerId]))
      .rows[0];
    // Defence in depth: the orchestrator classified the call already; this layer talks only to the authenticated owner.
    if (!owner || owner.telegram_user_id !== plan.recipientTelegramId) return { endReason: 'cancelled', usageMicroUsd: 0, conversationHeld: false };

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
      contacts: this.d.contacts,
      contactCalls: this.d.contactCalls,
      recall: this.d.recall,
      onEndCall: () => endRequested(),
    });
    await tools.load();
    const asked = plan.topic === 'reminder' && plan.allowedContext[0] === OWNER_REQUESTED_CALL;
    const calledIn = plan.topic === 'reminder' && plan.allowedContext[0] === OWNER_CALLED_IN; // the owner rang the assistant
    const reminder = plan.topic === 'reminder' && !asked && !calledIn ? (plan.allowedContext[0] ?? undefined) : undefined;
    const knowledge = this.d.recall ? await this.d.recall.recall(db, ownerId, '', this.d.clock.now(), { calls: 5, memories: 12 }) : undefined;
    const instructions = buildOwnerCallInstructions({
      ...(knowledge ? { knowledge } : {}),
      now: this.d.clock.now(),
      timezone: owner.timezone,
      tasks: tools.describeList(),
      ...(reminder ? { reminder } : {}),
    });
    const link = this.d.makeLink({ instructions, tools: OWNER_CALL_TOOL_DECLARATIONS });
    const bridge = new RealtimeCallBridge(handle, link, {
      ...(this.d.log ? { log: this.d.log } : {}),
      logContent: this.d.logContent,
      onTool: (c) => tools.execute(c),
    });
    const started = Date.now();
    const first = !(await answeredEarlierToday(db, ownerId, plan.recipientTelegramId, ctx.callId, owner.timezone, this.d.clock.now()));
    const greeting = calledIn
      ? GREETING_INBOUND(first, this.d.ownerName)
      : asked
        ? GREETING_ASKED(first, this.d.ownerName)
        : reminder
          ? GREETING_REMINDER(first)
          : GREETING_BRIEFING(first);
    bridge.start(greeting);

    // The owner picks up and may say nothing: the assistant must speak first, quickly, and ask again if nobody answers.
    let spoke = false;
    let resent = 0;
    let nudges = 0;
    let ownerSpoke = false; // set by the model's own transcript of the owner, which does not depend on how loud the line is
    link.onTranscript((who) => {
      if (who === 'caller') {
        ownerSpoke = true;
        tools.noteOwnerSpoke();
      }
    });
    let lastActivity = Date.now();
    let seenAudio = 0;
    let seenVoice = 0;
    const watcher = setInterval(() => {
      const now = Date.now();
      const s = bridge.stats;
      if (s.modelAudioChunks !== seenAudio || s.nonSilentFramesIn !== seenVoice) {
        if (!spoke && s.modelAudioChunks > 0) this.d.log?.(`owner call: first words ${now - started} ms after the call was answered`);
        spoke = spoke || s.modelAudioChunks > 0;
        seenAudio = s.modelAudioChunks;
        seenVoice = s.nonSilentFramesIn;
        lastActivity = now;
        return;
      }
      if (!spoke && now - started >= 3500 && resent < 2) {
        resent++;
        this.d.log?.(`owner call: no voice ${Math.round((now - started) / 1000)} s after answering, asking the model again`);
        link.respond(greeting);
        lastActivity = now;
      } else if (spoke && !ownerSpoke && s.nonSilentFramesIn === 0 && now - lastActivity >= 7000 && nudges < 2) {
        // The owner has not said a single word since answering: ask once more, briefly. Never once the conversation has started.
        nudges++;
        link.respond(NUDGE(this.d.ownerName));
        lastActivity = now;
      }
    }, 500);

    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<'limit'>((r) => (timer = setTimeout(() => r('limit'), plan.maxDurationSeconds * 1000)));
    const why = await Promise.race([
      endAsked.then(() => 'end' as const),
      bridge.finished.then(() => 'over' as const),
      bridge.fatal.then(() => 'fatal' as const), // the AI session was lost: do not keep a silent call open until the time limit
      limit,
    ]);
    clearTimeout(timer);
    clearInterval(watcher);
    bridge.stop();
    const seconds = (Date.now() - started) / 1000;
    const usageMicroUsd = this.d.costUsdPerMinute ? Math.round((seconds / 60) * this.d.costUsdPerMinute * 1_000_000) : undefined;
    const heardOwner = bridge.stats.callerTranscripts > 0 || bridge.stats.nonSilentFramesIn >= 100; // words heard, not just line noise
    return {
      endReason: why === 'fatal' ? 'transport_error' : why === 'limit' ? 'duration_limit' : 'completed',
      conversationHeld: heardOwner && why !== 'fatal',
      ...(usageMicroUsd !== undefined ? { usageMicroUsd } : {}),
    };
  }
}
