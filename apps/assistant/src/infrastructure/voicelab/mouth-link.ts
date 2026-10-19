import type { RealtimeLink, ToolCall } from '../../modules/calls/audio/realtime-bridge.js';
import { StreamingResampler } from '../../modules/calls/audio/resampler.js';
import type { Synthesizer, TtsLanguage } from './tts.js';

/** A realtime session that answers in TEXT (the "brain": it listens, decides, calls tools) and streams the text as it is written. */
export interface TextBrain extends RealtimeLink {
  onText(cb: (delta: string, done: boolean) => void): void;
}

const OUT_RATE = 24_000;
const DEGRADE_AFTER = 2;

const EMOJI = new RegExp(String.raw`\p{Extended_Pictographic}|\u200d|\ufe0f`, 'gu');

/** One spoken chunk: markdown, emoji and symbols a voice must not read are dropped. */
export function speakable(s: string): string {
  return s
    .replace(/[*_`#>~|]/g, ' ')
    .replace(EMOJI, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function languageOf(s: string): TtsLanguage {
  if (/[А-Яа-яЁё]/.test(s)) return 'ru';
  const w = s.toLowerCase().match(/[a-z']+/g) ?? [];
  const en = w.filter((x) => /^(the|and|you|your|is|are|hello|please|thank|thanks|yes|no|price|call|ok|okay|sorry|i|we|will|can)$/.test(x)).length;
  return w.length >= 3 && en / w.length >= 0.4 ? 'en' : 'uz';
}

/** Cuts finished sentences off the front of a growing buffer; the unfinished rest stays. A long run without punctuation is cut at a comma/space. */
export function takeSentences(buf: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let rest = buf;
  for (;;) {
    const m = /[.!?…]+["')»]?(?:\s+|$)|\n+/.exec(rest);
    if (!m || m.index + m[0].length === 0) break;
    // "12.5" has no space after the dot, so it is not a boundary; a boundary at the very end of the buffer waits for the next delta
    if (m.index + m[0].length === rest.length && !/\n/.test(m[0]) && !/\s$/.test(m[0])) break;
    sentences.push(rest.slice(0, m.index + m[0].length));
    rest = rest.slice(m.index + m[0].length);
  }
  if (rest.length > 220) {
    const cut = Math.max(rest.lastIndexOf(', ', 200), rest.lastIndexOf(' ', 200));
    if (cut > 40) {
      sentences.push(rest.slice(0, cut + 1));
      rest = rest.slice(cut + 1);
    }
  }
  return { sentences, rest };
}

/**
 * The AI's voice is VoiceLab's (e.g. Nozima, Uzbek) while another realtime model does the listening and thinking in text.
 * Text is cut into sentences, each sentence is synthesised at once (in parallel, played in order), and audio is handed to the call as
 * soon as the first sentence is ready. Barge-in drops everything not yet played. A tool call waits until what the model said before it
 * has been voiced, so "goodbye" + end_call never hangs up in the middle of the farewell.
 */
export class VoiceLabMouthLink implements RealtimeLink {
  readonly inputRateHz: number;
  readonly outputRateHz = OUT_RATE;
  #audio: Array<(pcm: Uint8Array) => void> = [];
  #errors: Array<(m: string) => void> = [];
  #buf = '';
  #epoch = 0;
  #chain: Promise<void> = Promise.resolve();
  #abort = new AbortController();
  /** When the audio handed to the call so far finishes playing (wall clock): the caller can only be "talked over" before this moment. */
  #audibleUntil = 0;
  #idle: NodeJS.Timeout | undefined;
  /** Consecutive synthesis failures; at DEGRADE_AFTER the brain's own voice (when it makes audio) takes over for the rest of the call. */
  #failures = 0;
  #degraded = false;
  #brainResampler: StreamingResampler | undefined;

  constructor(
    private readonly brain: TextBrain,
    private readonly tts: Synthesizer,
    private readonly o: {
      log?: ((line: string) => void) | undefined;
      /** How long the text may stay quiet before the unfinished rest is voiced anyway (after a full stop / otherwise). */
      idleFlushMs?: { sentence: number; other: number } | undefined;
    } = {},
  ) {
    this.inputRateHz = brain.inputRateHz;
    // Fallback voice: a brain that also produces audio (Gemini in 'transcript' mode) keeps talking in ITS voice once VoiceLab is out of
    // service (e.g. no credits left). Normally that audio is dropped. A brain that answers in text only can not do this.
    if (brain.outputRateHz !== OUT_RATE) this.#brainResampler = new StreamingResampler(brain.outputRateHz, OUT_RATE);
    brain.onAudio((pcm) => {
      if (!this.#degraded) return;
      const out = this.#brainResampler ? this.#brainResampler.process(pcm) : pcm;
      this.#audibleUntil = Math.max(this.#audibleUntil, Date.now()) + (out.length / 2 / OUT_RATE) * 1000;
      for (const cb of this.#audio) cb(out);
    });
    brain.onText((delta, done) => {
      this.#buf += delta;
      const { sentences, rest } = takeSentences(this.#buf);
      this.#buf = rest;
      for (const s of sentences) this.#enqueue(s);
      clearTimeout(this.#idle);
      if (done) this.#flush();
      else if (this.#buf.trim()) {
        // The model's turn-complete signal can arrive seconds after its last words (it follows the audio it generated). The last sentence has no
        // space after its full stop yet, so without this it would wait for that signal: speak it as soon as the text goes quiet.
        const idle = this.o.idleFlushMs ?? { sentence: 200, other: 900 };
        this.#idle = setTimeout(() => this.#flush(), /[.!?…]["')»]?\s*$/.test(this.#buf) ? idle.sentence : idle.other);
      }
    });
  }

  #flush(): void {
    clearTimeout(this.#idle);
    const rest = this.#buf;
    this.#buf = '';
    this.#enqueue(rest);
  }

  #enqueue(raw: string): void {
    const text = speakable(raw);
    if (!/[\p{L}\p{N}]/u.test(text)) return;
    if (this.#degraded) return; // the brain's own voice is speaking this
    const epoch = this.#epoch;
    const signal = this.#abort.signal;
    const pending = this.tts.synthesize(text, languageOf(text), signal);
    pending.catch(() => undefined); // reported where it is awaited; a dropped one must not become an unhandled rejection
    this.#chain = this.#chain.then(async () => {
      if (epoch !== this.#epoch) return;
      try {
        const t0 = Date.now();
        const a = await pending;
        if (epoch !== this.#epoch) return;
        this.#failures = 0;
        this.o.log?.(`voicelab: ${text.length} chars voiced (waited ${Date.now() - t0} ms for the synthesis)`);
        const pcm = a.rateHz === OUT_RATE ? a.pcm : new StreamingResampler(a.rateHz, OUT_RATE).process(a.pcm);
        this.#audibleUntil = Math.max(this.#audibleUntil, Date.now()) + (pcm.length / 2 / OUT_RATE) * 1000;
        // ~100 ms pieces keep barge-in responsive
        for (let i = 0; i < pcm.length; i += 4800) {
          if (epoch !== this.#epoch) return;
          for (const cb of this.#audio) cb(pcm.subarray(i, i + 4800));
        }
      } catch (e) {
        if (epoch === this.#epoch) {
          for (const cb of this.#errors) cb(`voicelab tts: ${String((e as Error)?.message ?? e)}`);
          if (++this.#failures >= DEGRADE_AFTER && !this.#degraded) {
            this.#degraded = true;
            this.o.log?.("voicelab: unavailable, switching to the AI model's own voice for the rest of the call");
          }
        }
      }
    });
  }

  sendAudio(pcm: Uint8Array): void {
    this.brain.sendAudio(pcm);
  }
  respond(instructions?: string): void {
    this.brain.respond(instructions);
  }
  interrupt(playedMs: number): void {
    clearTimeout(this.#idle);
    this.#epoch++;
    this.#audibleUntil = 0;
    this.#buf = '';
    this.#abort.abort();
    this.#abort = new AbortController();
    this.o.log?.('voicelab: speech dropped (barge-in)');
    this.brain.interrupt(playedMs);
  }
  onResponseStart(cb: () => void): void {
    this.brain.onResponseStart(cb);
  }
  onToolCall(cb: (c: ToolCall) => void): void {
    this.brain.onToolCall((call) => {
      this.#flush();
      void this.#chain.then(() => cb(call));
    });
  }
  sendToolResult(call: ToolCall, result: unknown, opts: { respond: boolean }): void {
    this.brain.sendToolResult(call, result, opts);
  }
  onAudio(cb: (pcm: Uint8Array) => void): void {
    this.#audio.push(cb);
  }
  onSpeechStarted(cb: () => void): void {
    this.brain.onSpeechStarted(() => {
      // The model reports "the caller started talking" as soon as it hears it; this voice lags the model by a second or two. When the caller
      // has not heard anything of the answer yet there is nothing to cut off: dropping it would leave the caller in silence (then talking
      // again, and again interrupting). Only speech over audible audio is a real barge-in.
      if (Date.now() >= this.#audibleUntil) {
        this.o.log?.('voicelab: caller speech before anything was audible, nothing to stop');
        return;
      }
      cb();
    });
  }
  onTranscript(cb: (who: 'assistant' | 'caller', text: string) => void): void {
    this.brain.onTranscript(cb);
  }
  onError(cb: (m: string) => void): void {
    this.#errors.push(cb);
    this.brain.onError(cb);
  }
  close(): void {
    clearTimeout(this.#idle);
    this.#epoch++;
    this.#abort.abort();
    this.brain.close();
  }
}
