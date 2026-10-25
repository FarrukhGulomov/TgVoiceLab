import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApprovedCallPlan, CallHandle, PcmFrame } from '@tgvl/contracts';
import { createTestDb, type TestDb } from '../support/test-db.js';
import { seedOwner, type SeededOwner } from '../support/seed.js';
import { boot } from '../support/harness.js';
import { FakeClock } from '../../apps/assistant/src/application/clock.js';
import { OwnerCallRunner } from '../../apps/assistant/src/modules/calls/conversation/owner-call-runner.js';
import type { RealtimeLink, ToolCall, ToolDeclaration } from '../../apps/assistant/src/modules/calls/audio/realtime-bridge.js';

let t: TestDb;
let o: SeededOwner;
const NOW = '2026-10-16T04:00:00Z'; // 09:00 Samarkand
beforeEach(async () => {
  t = await createTestDb();
  o = await seedOwner(t.db);
});
afterEach(async () => {
  await t.drop();
});

class FakeLink implements RealtimeLink {
  inputRateHz = 24000;
  outputRateHz = 24000;
  greeting: string | undefined;
  closed = false;
  results: Array<{ id: string; result: unknown; respond: boolean }> = [];
  toolCb?: (c: ToolCall) => void;
  sendAudio() {}
  respond(i?: string) {
    this.greeting = i;
  }
  interrupt() {}
  onResponseStart() {}
  onAudio() {}
  onSpeechStarted() {}
  onTranscript(cb: (who: 'assistant' | 'caller', text: string) => void) {
    this.transcriptCbs.push(cb);
  }
  errorCb?: (m: string) => void;
  onError(cb: (m: string) => void) {
    this.errorCb = cb;
  }
  transcriptCbs: Array<(who: 'assistant' | 'caller', text: string) => void> = [];
  transcriptCb = (who: 'assistant' | 'caller', text: string) => this.transcriptCbs.forEach((f) => f(who, text)); // the bridge and the runner both listen
  onToolCall(cb: (c: ToolCall) => void) {
    this.toolCb = cb;
  }
  sendToolResult(c: ToolCall, result: unknown, opts: { respond: boolean }) {
    this.results.push({ id: c.id, result, respond: opts.respond });
  }
  close() {
    this.closed = true;
  }
}

function fakeHandle() {
  const queue: PcmFrame[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  const incoming = (async function* () {
    for (;;) {
      while (queue.length) yield queue.shift()!;
      if (done) return;
      await new Promise<void>((r) => (wake = r));
    }
  })();
  const handle = {
    callId: 'c1',
    incomingAudio: incoming,
    events: (async function* () {})(),
    sendAudio: async () => undefined,
    flushOutput: async () => undefined,
    end: async () => undefined,
  } as unknown as CallHandle;
  return {
    handle,
    hangUp: () => {
      done = true;
      wake?.();
    },
  };
}

const plan = (over: Partial<ApprovedCallPlan> = {}): ApprovedCallPlan => ({
  callRequestId: '11111111-1111-4111-8111-111111111111',
  ownerId: o.ownerId,
  recipientTelegramId: o.telegramUserId,
  topic: 'briefing',
  purpose: 'Kunlik brifing',
  questions: [],
  allowedContext: [],
  forbiddenCommitments: [],
  language: 'uz',
  maxDurationSeconds: 60,
  authorizationId: '33333333-3333-4333-8333-333333333333',
  permissionVersion: 0,
  planHash: 'a'.repeat(64),
  expiresAt: '2026-10-16T05:00:00.000Z',
  ...over,
});

async function setup() {
  const clock = new FakeClock(new Date(NOW));
  const app = boot(t.url, clock);
  const links: Array<{ link: FakeLink; instructions: string; tools: ToolDeclaration[] }> = [];
  const runner = new OwnerCallRunner({
    db: app.db,
    tasks: app.tasks,
    reminders: app.reminders,
    clock,
    callRemindersLive: false,
    costUsdPerMinute: 0.6,
    makeLink: ({ instructions, tools }) => {
      const link = new FakeLink();
      links.push({ link, instructions, tools });
      return link;
    },
  });
  return { app, clock, runner, links };
}
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
/** Polls instead of sleeping a fixed time: a loaded CI machine is slower than the sleep. */
const until = async (ok: () => boolean, ms = 5000) => {
  for (const start = Date.now(); !ok() && Date.now() - start < ms;) await tick(10);
};

describe('OwnerCallRunner', () => {
  it('opens a voice session with the owner tools and the real task list, greets, and completes when the model ends the call', async () => {
    const s = await setup();
    await s.app.tasks.create(s.app.db, o.ownerId, { title: 'Hisobot', dueAt: new Date('2026-10-16T10:00:00Z') });
    const h = fakeHandle();
    const run = s.runner.run({ callId: 'c1', ownerId: o.ownerId, plan: plan(), handle: h.handle });
    await until(() => s.links.length > 0);
    const { link, instructions, tools } = s.links[0]!;
    expect(instructions).toContain('1. Hisobot (muddati: 2026-10-16 15:00)');
    expect(instructions).toContain('2026-10-16 09:00 (Asia/Samarkand)');
    expect(tools.map((x) => x.name)).toEqual([
      'list_tasks',
      'complete_task',
      'move_task',
      'create_task',
      'create_reminder',
      'call_contact',
      'recall',
      'end_call',
    ]);
    await until(() => !!link.greeting);
    expect(link.greeting).toContain("Vazifalarni qisqa o'qib ber");
    // the model completes a task by voice: committed, then confirmed
    link.toolCb!({ id: 'a', name: 'complete_task', args: { number: 1 } });
    await until(() => link.results.length > 0);
    expect(link.results[0]).toEqual({ id: 'a', result: { ok: true, title: 'Hisobot', alreadyDone: false }, respond: true });
    expect((await t.db.query(`SELECT status FROM tasks`)).rows[0].status).toBe('done');
    // the model ends the call after the farewell
    link.toolCb!({ id: 'b', name: 'end_call', args: {} });
    const res = await run;
    expect(res.endReason).toBe('completed');
    expect(res.usageMicroUsd).toBeGreaterThanOrEqual(0);
    expect(link.closed).toBe(true);
    h.hangUp();
    await s.app.close();
  });

  it('a reminder call speaks the reminder text as data and says what it will really do with by_call', async () => {
    const s = await setup();
    const h = fakeHandle();
    const run = s.runner.run({
      callId: 'c1',
      ownerId: o.ownerId,
      plan: plan({ topic: 'reminder', purpose: 'Eslatma: Dori ichish', allowedContext: ['Dori ichish'] }),
      handle: h.handle,
    });
    await tick(80);
    const { link, instructions } = s.links[0]!;
    expect(instructions).toContain('«Dori ichish»');
    expect(instructions).toContain("MA'LUMOT");
    await until(() => !!link.greeting);
    expect(link.greeting).toContain('Eslatmani ayt');
    link.toolCb!({ id: 'r', name: 'create_reminder', args: { text: 'Uchrashuv', date: '2026-10-16', time: '16:00', by_call: true } });
    for (let i = 0; i < 50 && link.results.length === 0; i++) await tick();
    expect(link.results[0]!.result).toMatchObject({ ok: true, delivery: 'message_until_calls_enabled' });
    h.hangUp();
    expect((await run).endReason).toBe('completed');
    await s.app.close();
  });

  it('talks only to the owner: a call to anyone else gets no conversation and no AI session', async () => {
    const s = await setup();
    const h = fakeHandle();
    const res = await s.runner.run({ callId: 'c1', ownerId: o.ownerId, plan: plan({ recipientTelegramId: '555000111' }), handle: h.handle });
    expect(res.endReason).toBe('cancelled');
    expect(s.links).toHaveLength(0);
    h.hangUp();
    await s.app.close();
  });

  it('ends with completed when the other side hangs up, and with duration_limit at the plan limit', async () => {
    const s = await setup();
    const h1 = fakeHandle();
    const run1 = s.runner.run({ callId: 'c1', ownerId: o.ownerId, plan: plan(), handle: h1.handle });
    await tick(80);
    h1.hangUp(); // the incoming audio stream ends: the call is over
    expect((await run1).endReason).toBe('completed');
    expect(s.links[0]!.link.closed).toBe(true);

    const h2 = fakeHandle();
    const limited = await s.runner.run({ callId: 'c2', ownerId: o.ownerId, plan: plan({ maxDurationSeconds: 1 }), handle: h2.handle });
    expect(limited.endReason).toBe('duration_limit');
    expect(s.links[1]!.link.closed).toBe(true);
    h2.hangUp();
    await s.app.close();
  });

  it('audit F-02: when the AI session is lost the call ends as a failure at once (not as "completed" after the time limit)', async () => {
    const s = await setup();
    const h = fakeHandle();
    const run = s.runner.run({ callId: 'c1', ownerId: o.ownerId, plan: plan({ maxDurationSeconds: 3600 }), handle: h.handle });
    await until(() => s.links.length > 0 && !!s.links[0]!.link.errorCb);
    s.links[0]!.link.errorCb!('websocket closed (1006) ');
    const res = await Promise.race([run, tick(2000).then(() => 'still running' as const)]);
    expect(res).not.toBe('still running');
    expect((res as { endReason: string }).endReason).toBe('transport_error');
    expect((res as { conversationHeld?: boolean }).conversationHeld).toBe(false);
    h.hangUp();
    await s.app.close();
  });

  it('audit F-04: conversationHeld follows what the recogniser heard, not line noise', async () => {
    const quiet = await setup();
    const h1 = fakeHandle();
    const r1 = quiet.runner.run({ callId: 'c1', ownerId: o.ownerId, plan: plan(), handle: h1.handle });
    await until(() => quiet.links.length > 0 && !!quiet.links[0]!.link.toolCb);
    quiet.links[0]!.link.toolCb!({ id: 'b', name: 'end_call', args: {} });
    expect((await r1).conversationHeld).toBe(false); // nobody said anything
    h1.hangUp();
    await quiet.app.close();

    const talked = await setup();
    const h2 = fakeHandle();
    const r2 = talked.runner.run({ callId: 'c2', ownerId: o.ownerId, plan: plan(), handle: h2.handle });
    await until(() => talked.links.length > 0 && talked.links[0]!.link.transcriptCbs.length > 1 && !!talked.links[0]!.link.toolCb);
    talked.links[0]!.link.transcriptCb('caller', 'Salom, vazifalarim qanday?');
    talked.links[0]!.link.toolCb!({ id: 'b', name: 'end_call', args: {} });
    expect((await r2).conversationHeld).toBe(true);
    h2.hangUp();
    await talked.app.close();
  });
});
