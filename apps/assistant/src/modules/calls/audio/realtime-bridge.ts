import type { CallHandle } from '@tgvl/contracts';
import { FrameAssembler, StreamingResampler } from './resampler.js';

export interface ToolDeclaration {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>;
}
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}
export interface ToolOutcome {
  /** Returned to the model as the tool's result. Only report success for what the application actually committed. */
  result: unknown;
  /** Let the model keep talking after the result (default true). `false` for end_call: the call is about to end. */
  respond?: boolean;
  /** Runs after the model's already-spoken audio has been played out to the caller (e.g. hang up). */
  afterPlayout?: () => void | Promise<void>;
}

/** The AI voice session as the bridge sees it (OpenAI Realtime in production; a fake in tests). Audio is s16le mono; the model's input and output rates may differ (e.g. 16 kHz in / 24 kHz out). */
export interface RealtimeLink {
  readonly inputRateHz: number;
  readonly outputRateHz: number;
  sendAudio(pcm: Uint8Array): void;
  /** Ask the model to speak now (e.g. the greeting). */
  respond(instructions?: string): void;
  /**
   * The caller barged in: stop the in-flight response (if any) and tell the model how much of it was actually played, so the part the
   * caller never heard does not stay in the conversation as if it had been said.
   */
  interrupt(playedMs: number): void;
  /** A new model response started (the bridge restarts its played-audio clock). */
  onResponseStart(cb: () => void): void;
  onAudio(cb: (pcm: Uint8Array) => void): void;
  onSpeechStarted(cb: () => void): void;
  onTranscript(cb: (who: 'assistant' | 'caller', text: string) => void): void;
  onError(cb: (message: string) => void): void;
  /** The model asked to run one of the declared tools. */
  onToolCall(cb: (call: ToolCall) => void): void;
  sendToolResult(call: ToolCall, result: unknown, opts: { respond: boolean }): void;
  close(): void;
}

/** Root-mean-square level of s16le samples. */
export function rmsS16(b: Uint8Array): number {
  const n = Math.floor(b.length / 2);
  if (!n) return 0;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = v.getInt16(i * 2, true);
    sum += x * x;
  }
  return Math.sqrt(sum / n);
}

const CALL_RATE = 48_000;
const FRAME_BYTES = (CALL_RATE / 100) * 2; // 10 ms

export interface BridgeOptions {
  log?: ((line: string) => void) | undefined;
  /** Put what was said and the tool arguments into log lines. Off by default: those are private conversation content. */
  logContent?: boolean | undefined;
  /** How long a requested greeting may stay unanswered before the silence is reported as an error. */
  silenceMs?: number | undefined;
  /** Extra time after the output buffer drained, for the last audio to reach the caller before an after-playout action. */
  playoutGraceMs?: number | undefined;
  /** Executes the model's tool calls. Without it every tool call is answered with an error. */
  onTool?: ((call: ToolCall) => Promise<ToolOutcome> | ToolOutcome) | undefined;
}

export interface BridgeStats {
  callFramesIn: number;
  /** Incoming 10 ms frames with real signal (RMS above a small floor): proof that audio from the person arrives, not just silence. */
  nonSilentFramesIn: number;
  modelAudioChunks: number;
  callFramesOut: number;
  bargeIns: number;
  errors: string[];
}

/**
 * Connects one live call to one AI voice session: caller audio -> resample -> model, model audio -> resample -> exact 10 ms frames -> call.
 * Barge-in: when the model reports that the caller started speaking, queued model audio is dropped at once (flush + assembler reset)
 * and the in-flight response is cancelled, so the assistant stops talking over the person.
 */
export class RealtimeCallBridge {
  readonly stats: BridgeStats = { callFramesIn: 0, nonSilentFramesIn: 0, modelAudioChunks: 0, callFramesOut: 0, bargeIns: 0, errors: [] };
  readonly log: (line: string) => void;
  readonly silenceMs: number;
  readonly logContent: boolean;
  readonly playoutGraceMs: number;
  readonly onTool: BridgeOptions['onTool'];
  /** Resolves when the call's incoming audio ends, i.e. the call is over (hung up by either side, or ended by the orchestrator). */
  readonly finished: Promise<void>;
  #finish!: () => void;
  #stopped = false;
  #pendingAction = false;
  #actionToken = 0; // bumped by caller speech: a pending after-playout action (hang up) is cancelled when the caller is still talking
  #up: StreamingResampler;
  #down: StreamingResampler;
  #assembler = new FrameAssembler(FRAME_BYTES);
  #outChain: Promise<void> = Promise.resolve();
  #silenceTimer: NodeJS.Timeout | undefined;
  #epoch = 0; // bumped on barge-in: audio queued before it is never sent
  #playedFrames = 0; // 10 ms frames of the current response that were actually handed to the call

  constructor(
    private readonly handle: CallHandle,
    private readonly link: RealtimeLink,
    o: BridgeOptions = {},
  ) {
    this.log = o.log ?? (() => undefined);
    this.silenceMs = o.silenceMs ?? 15_000;
    this.logContent = o.logContent === true;
    this.playoutGraceMs = o.playoutGraceMs ?? 400;
    this.onTool = o.onTool;
    this.finished = new Promise<void>((r) => (this.#finish = r));
    this.#up = new StreamingResampler(CALL_RATE, link.inputRateHz);
    this.#down = new StreamingResampler(link.outputRateHz, CALL_RATE);
  }

  start(greeting?: string): void {
    this.link.onAudio((pcm) => {
      if (this.#stopped) return;
      this.stats.modelAudioChunks++;
      const epoch = this.#epoch;
      const frames = this.#assembler.push(this.#down.process(pcm));
      for (const samples of frames) {
        this.#outChain = this.#outChain
          .then(async () => {
            if (this.#stopped || epoch !== this.#epoch) return; // dropped by a barge-in
            await this.handle.sendAudio({
              callId: this.handle.callId,
              sequence: this.stats.callFramesOut,
              monotonicTimestampUs: 0,
              sampleRateHz: CALL_RATE,
              channels: 1,
              encoding: 's16le',
              samples,
            });
            this.stats.callFramesOut++;
            this.#playedFrames++;
          })
          // One rejected send must not poison the chain (the next frame would never be attempted and the rejection would go unhandled).
          .catch((e: unknown) => {
            if (this.stats.errors.length < 20) this.stats.errors.push(`audio out: ${String((e as Error)?.message ?? e)}`);
          });
      }
    });
    this.link.onSpeechStarted(() => {
      if (this.#stopped) return;
      this.stats.bargeIns++;
      if (this.#pendingAction) {
        this.log('the caller spoke after the end of the call was requested: hang-up cancelled');
        this.#pendingAction = false;
      }
      this.#actionToken++;
      this.#epoch++;
      this.#assembler.clear();
      this.#down = new StreamingResampler(this.link.outputRateHz, CALL_RATE);
      void this.handle.flushOutput().catch(() => undefined);
      this.link.interrupt(this.#playedFrames * 10);
      this.#playedFrames = 0;
    });
    this.link.onResponseStart(() => {
      this.#playedFrames = 0;
    });
    this.link.onToolCall((call) => {
      void (async () => {
        let out: ToolOutcome;
        try {
          out = this.onTool ? await this.onTool(call) : { result: { error: `unknown tool ${call.name}` } };
        } catch (e) {
          // A tool that failed must tell the model it failed: never a success the application did not commit.
          out = { result: { error: String((e as Error)?.message ?? e).slice(0, 200) } };
        }
        if (this.#stopped) return;
        this.log(this.logContent ? `tool ${call.name}(${JSON.stringify(call.args)})` : `tool ${call.name}(${Object.keys(call.args ?? {}).length} argument(s))`);
        this.link.sendToolResult(call, out.result, { respond: out.respond ?? true });
        if (out.afterPlayout) {
          const token = ++this.#actionToken;
          this.#pendingAction = true;
          await this.#outChain; // everything the model already said is in the call's output buffer...
          await this.handle.drained?.().catch(() => undefined); // ...now let it actually play
          await new Promise((r) => setTimeout(r, this.playoutGraceMs));
          if (token !== this.#actionToken || this.#stopped) return; // the caller spoke (or the call ended) while we waited
          this.#pendingAction = false;
          await out.afterPlayout();
        }
      })().catch((e: unknown) => this.stats.errors.push(`tool: ${String((e as Error)?.message ?? e)}`));
    });
    this.link.onTranscript((who, text) => this.log(this.logContent ? `${who}: ${text}` : `${who}: [${text.length} characters]`));
    this.link.onError((m) => {
      this.stats.errors.push(m);
      this.log(`realtime error: ${m}`);
    });

    void (async () => {
      for await (const f of this.handle.incomingAudio) {
        if (this.#stopped) break;
        this.stats.callFramesIn++;
        if (rmsS16(f.samples) > 300) this.stats.nonSilentFramesIn++;
        this.link.sendAudio(this.#up.process(f.samples));
      }
    })()
      .catch((e: unknown) => this.stats.errors.push(`incoming audio: ${String((e as Error)?.message ?? e)}`))
      .finally(() => this.#finish());

    if (greeting) {
      this.link.respond(greeting);
      // A model that never speaks must be visible, not silent: no error event arrives for "nothing happened".
      this.#silenceTimer = setTimeout(() => {
        if (!this.#stopped && this.stats.modelAudioChunks === 0) {
          const m = `the model produced no audio ${this.silenceMs / 1000} s after the greeting request`;
          this.stats.errors.push(m);
          this.log(`error: ${m}`);
        }
      }, this.silenceMs);
    }
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#silenceTimer);
    this.link.close();
  }
}
