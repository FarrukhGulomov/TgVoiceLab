/**
 * Messages sent to a model session before the socket is open (or before its setup is acknowledged). Control messages (setup follow-ups, tool
 * results, "respond now") are kept in order; AUDIO is bounded: when the session takes too long to open, the OLDEST audio is dropped
 * (stale speech is no use to a model that joins late) instead of growing without limit.
 */
export class PreOpenQueue {
  #items: Array<{ s: string; audio: boolean }> = [];
  #audioChars = 0;
  droppedAudio = 0;

  /** `maxAudioChars` counts the characters of base64 audio payloads (about 1.5 MB = roughly 45 s of 16 kHz PCM). */
  constructor(private readonly maxAudioChars = 1_500_000) {}

  push(s: string, audio = false): void {
    this.#items.push({ s, audio });
    if (!audio) return;
    this.#audioChars += s.length;
    while (this.#audioChars > this.maxAudioChars) {
      const i = this.#items.findIndex((x) => x.audio);
      if (i < 0) break;
      this.#audioChars -= this.#items[i]!.s.length;
      this.#items.splice(i, 1);
      this.droppedAudio++;
    }
  }

  /** Everything queued, in order; the queue is empty afterwards. */
  drain(): string[] {
    const out = this.#items.map((x) => x.s);
    this.#items = [];
    this.#audioChars = 0;
    return out;
  }

  get size(): number {
    return this.#items.length;
  }
}
