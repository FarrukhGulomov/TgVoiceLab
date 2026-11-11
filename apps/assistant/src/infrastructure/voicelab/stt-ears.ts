import { AutoGain } from '../audio/auto-gain.js';
import type { ToolCall } from '../../modules/calls/audio/realtime-bridge.js';
import type { SttStream } from './stt-stream.js';
import { STT_MAX_COMMIT_MS } from './stt-stream.js';
import type { TextBrain } from './mouth-link.js';
import type { TurnTimer } from './turn-timer.js';

/** A text brain that can also be given the caller's words as text. */
export interface UserTextBrain extends TextBrain {
  sendUserText(text: string): void;
}

export interface EarsOptions {
  /** Silence that ends an utterance (VoiceLab does not detect it: we commit). */
  silenceMs?: number | undefined;
  /** RMS of s16le samples that counts as speech. */
  level?: number | undefined;
  /** Shorter sounds than this never reach the model. */
  minSpeechMs?: number | undefined;
  /** Audio kept from before the speech was detected so the first syllable is not lost. */
  preRollMs?: number | undefined;
  log?: ((line: string) => void) | undefined;
  timer?: TurnTimer | undefined;
  now?: (() => number) | undefined;
}

const RATE = 16_000;

/**
 * The call's EARS: VoiceLab's recogniser listens, the thinking model (Gemini / OpenAI) only reads. Caller audio (16 kHz, as the bridge delivers it)
 * is levelled, cut into utterances by a voice-activity detector (silence_ms ends one), streamed to VoiceLab and committed; the final transcript is
 * handed to the model as the caller's words. The model never receives the caller's audio. While the caller speaks over the assistant, what the
 * model was still writing is dropped (it answered the previous turn).
 */
export class VoiceLabEars implements UserTextBrain {
  readonly inputRateHz = RATE;
  get outputRateHz(): number {
    return this.brain.outputRateHz;
  }
  #gain = new AutoGain();
  #speech: Array<() => void> = [];
  #transcript: Array<(who: 'assistant' | 'caller', text: string) => void> = [];
  #errors: Array<(m: string) => void> = [];
  #text: Array<(delta: string, done: boolean) => void> = [];
  #preRoll: Uint8Array[] = [];
  #preRollMs = 0;
  #talking = false;
  #speechMs = 0; // loud audio of the current utterance
  #sentMs = 0; // audio sent for the current utterance
  #quietMs = 0;
  #generating = false;
  #muted = false;

  constructor(
    private readonly brain: UserTextBrain,
    private readonly stream: SttStream,
    private readonly o: EarsOptions = {},
  ) {
    stream.onFinal((f) => {
      const text = f.text.replace(/\s+/g, ' ').trim();
      if (!/[\p{L}\p{N}]/u.test(text)) return; // silence or noise recognised as nothing
      this.o.timer?.mark('final');
      for (const cb of this.#transcript) cb('caller', text);
      this.#muted = false;
      this.brain.sendUserText(text);
    });
    stream.onError((m) => {
      for (const cb of this.#errors) cb(m);
    });
    brain.onText((delta, done) => {
      if (this.#muted) {
        if (done) this.#generating = false;
        return;
      }
      this.#generating = !done;
      for (const cb of this.#text) cb(delta, done);
    });
  }

  sendAudio(raw: Uint8Array): void {
    const pcm = this.#gain.process(raw);
    const n = Math.floor(pcm.length / 2);
    if (!n) return;
    const v = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const x = v.getInt16(i * 2, true);
      sum += x * x;
    }
    const ms = (n / RATE) * 1000;
    const loud = Math.sqrt(sum / n) > (this.o.level ?? 450);

    if (!this.#talking) {
      if (!loud) {
        this.#remember(pcm, ms);
        return;
      }
      this.#talking = true;
      this.#speechMs = 0;
      this.#sentMs = 0;
      this.#quietMs = 0;
      for (const p of this.#preRoll) this.#push(p);
      this.#preRoll = [];
      this.#preRollMs = 0;
      // The caller is talking over whatever the assistant was still writing: that answer is stale.
      if (this.#generating) this.#muted = true;
      for (const cb of this.#speech) cb();
    }

    this.#push(pcm);
    if (loud) {
      this.#speechMs += ms;
      this.#quietMs = 0;
    } else {
      this.#quietMs += ms;
    }
    // A very long speech is cut before the recogniser's 35 s limit; the caller keeps talking into the next utterance.
    if (this.#sentMs >= STT_MAX_COMMIT_MS - 5000) return void this.#end(false);
    if (this.#quietMs >= (this.o.silenceMs ?? 600)) this.#end(true);
  }

  #remember(pcm: Uint8Array, ms: number): void {
    this.#preRoll.push(pcm);
    this.#preRollMs += ms;
    const keep = this.o.preRollMs ?? 200;
    while (this.#preRoll.length > 1 && this.#preRollMs - (this.#preRoll[0]!.length / 2 / RATE) * 1000 >= keep) {
      this.#preRollMs -= (this.#preRoll[0]!.length / 2 / RATE) * 1000;
      this.#preRoll.shift();
    }
  }

  #push(pcm: Uint8Array): void {
    this.#sentMs += (pcm.length / 2 / RATE) * 1000;
    this.stream.sendAudio(pcm);
  }

  #end(silenceEnded: boolean): void {
    const real = this.#speechMs >= (this.o.minSpeechMs ?? 250);
    if (silenceEnded) this.o.timer?.mark('speechEnd', (this.o.now ?? Date.now)() - this.#quietMs); // the moment the caller actually stopped
    if (!real || !this.stream.commit()) {
      // A cough or a click: the audio already streamed is thrown away instead of becoming a (wrong) turn.
      this.stream.interrupt();
    } else {
      this.o.timer?.mark('commit');
      this.o.log?.(`stt: utterance committed (${Math.round(this.#sentMs)} ms of audio, ${Math.round(this.#speechMs)} ms of speech)`);
    }
    if (silenceEnded) this.#talking = false;
    else {
      this.#speechMs = 0;
      this.#sentMs = 0;
      this.#quietMs = 0;
    }
  }

  respond(instructions?: string): void {
    this.brain.respond(instructions);
  }
  sendUserText(text: string): void {
    this.brain.sendUserText(text);
  }
  interrupt(playedMs: number): void {
    this.brain.interrupt(playedMs);
  }
  onResponseStart(cb: () => void): void {
    this.brain.onResponseStart(cb);
  }
  onAudio(cb: (pcm: Uint8Array) => void): void {
    this.brain.onAudio(cb);
  }
  onText(cb: (delta: string, done: boolean) => void): void {
    this.#text.push(cb);
  }
  onSpeechStarted(cb: () => void): void {
    this.#speech.push(cb);
  }
  onTranscript(cb: (who: 'assistant' | 'caller', text: string) => void): void {
    this.#transcript.push(cb);
    this.brain.onTranscript((who, text) => {
      if (who === 'assistant') cb(who, text); // the model's "caller" transcript does not exist here: audio never reaches it
    });
  }
  onError(cb: (m: string) => void): void {
    this.#errors.push(cb);
    this.brain.onError(cb);
  }
  onToolCall(cb: (c: ToolCall) => void): void {
    this.brain.onToolCall(cb);
  }
  sendToolResult(call: ToolCall, result: unknown, opts: { respond: boolean }): void {
    this.brain.sendToolResult(call, result, opts);
  }
  close(): void {
    this.stream.close();
    this.brain.close();
  }
}
