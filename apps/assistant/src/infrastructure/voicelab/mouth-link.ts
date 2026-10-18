import type { RealtimeLink, ToolCall } from '../../modules/calls/audio/realtime-bridge.js';
import { StreamingResampler } from '../../modules/calls/audio/resampler.js';
import type { Synthesizer, TtsLanguage } from './tts.js';

/** A realtime session that answers in TEXT (the "brain": it listens, decides, calls tools) and streams the text as it is written. */
export interface TextBrain extends RealtimeLink {
  onText(cb: (delta: string, done: boolean) => void): void;
}

const OUT_RATE = 24_000;

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

  constructor(
    private readonly brain: TextBrain,
    private readonly tts: Synthesizer,
    private readonly o: { log?: ((line: string) => void) | undefined } = {},
  ) {
    this.inputRateHz = brain.inputRateHz;
    brain.onText((delta, done) => {
      this.#buf += delta;
      const { sentences, rest } = takeSentences(this.#buf);
      this.#buf = rest;
      for (const s of sentences) this.#enqueue(s);
      if (done) this.#flush();
    });
  }

  #flush(): void {
    const rest = this.#buf;
    this.#buf = '';
    this.#enqueue(rest);
  }

  #enqueue(raw: string): void {
    const text = speakable(raw);
    if (!/[\p{L}\p{N}]/u.test(text)) return;
    const epoch = this.#epoch;
    const signal = this.#abort.signal;
    const pending = this.tts.synthesize(text, languageOf(text), signal);
    pending.catch(() => undefined); // reported where it is awaited; a dropped one must not become an unhandled rejection
    this.#chain = this.#chain.then(async () => {
      if (epoch !== this.#epoch) return;
      try {
        const a = await pending;
        if (epoch !== this.#epoch) return;
        const pcm = a.rateHz === OUT_RATE ? a.pcm : new StreamingResampler(a.rateHz, OUT_RATE).process(a.pcm);
        // ~100 ms pieces keep barge-in responsive
        for (let i = 0; i < pcm.length; i += 4800) {
          if (epoch !== this.#epoch) return;
          for (const cb of this.#audio) cb(pcm.subarray(i, i + 4800));
        }
      } catch (e) {
        if (epoch === this.#epoch) for (const cb of this.#errors) cb(`voicelab tts: ${String((e as Error)?.message ?? e)}`);
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
    this.#epoch++;
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
    this.brain.onSpeechStarted(cb);
  }
  onTranscript(cb: (who: 'assistant' | 'caller', text: string) => void): void {
    this.brain.onTranscript(cb);
  }
  onError(cb: (m: string) => void): void {
    this.#errors.push(cb);
    this.brain.onError(cb);
  }
  close(): void {
    this.#epoch++;
    this.#abort.abort();
    this.brain.close();
  }
}
