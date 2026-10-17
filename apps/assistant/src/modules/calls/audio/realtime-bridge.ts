import type { CallHandle } from '@tgvl/contracts';
import { FrameAssembler, StreamingResampler } from './resampler.js';

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
  close(): void;
}

const CALL_RATE = 48_000;
const FRAME_BYTES = (CALL_RATE / 100) * 2; // 10 ms

export interface BridgeStats {
  callFramesIn: number;
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
  readonly stats: BridgeStats = { callFramesIn: 0, modelAudioChunks: 0, callFramesOut: 0, bargeIns: 0, errors: [] };
  #stopped = false;
  #up: StreamingResampler;
  #down: StreamingResampler;
  #assembler = new FrameAssembler(FRAME_BYTES);
  #outChain: Promise<void> = Promise.resolve();
  #epoch = 0; // bumped on barge-in: audio queued before it is never sent
  #playedFrames = 0; // 10 ms frames of the current response that were actually handed to the call

  constructor(
    private readonly handle: CallHandle,
    private readonly link: RealtimeLink,
    private readonly log: (line: string) => void = () => undefined,
  ) {
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
        this.#outChain = this.#outChain.then(async () => {
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
        });
      }
    });
    this.link.onSpeechStarted(() => {
      if (this.#stopped) return;
      this.stats.bargeIns++;
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
    this.link.onTranscript((who, text) => this.log(`${who}: ${text}`));
    this.link.onError((m) => {
      this.stats.errors.push(m);
      this.log(`realtime error: ${m}`);
    });

    void (async () => {
      for await (const f of this.handle.incomingAudio) {
        if (this.#stopped) break;
        this.stats.callFramesIn++;
        this.link.sendAudio(this.#up.process(f.samples));
      }
    })().catch((e: unknown) => this.stats.errors.push(`incoming audio: ${String((e as Error)?.message ?? e)}`));

    if (greeting) this.link.respond(greeting);
  }

  stop(): void {
    this.#stopped = true;
    this.link.close();
  }
}
