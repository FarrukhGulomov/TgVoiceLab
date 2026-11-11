/**
 * Times one conversational turn end to end, in milliseconds, with no words in it:
 * speech end -> commit -> final transcript -> first model text -> first synthesised chunk -> first audio handed to the call.
 * The synthesis step is reported on its own so a slow voice model is not mistaken for slow recognition.
 */
export type TurnMark = 'speechEnd' | 'commit' | 'final' | 'firstText' | 'ttsStart' | 'ttsChunk' | 'ttsDone' | 'firstAudio';
/** What must have happened before a mark counts. `ttsStart`, `ttsChunk` and `ttsDone` may come in any case (a turn can be voiced without a model text). */
const NEEDS: Partial<Record<TurnMark, TurnMark>> = { commit: 'speechEnd', final: 'commit', firstText: 'final', firstAudio: 'ttsChunk' };

export class TurnTimer {
  #t = new Map<TurnMark, number>();
  constructor(
    private readonly log: (line: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  has(m: TurnMark): boolean {
    return this.#t.has(m);
  }

  /** `speechEnd` starts a new turn; later marks count only once, in order, and only inside a turn. */
  mark(m: TurnMark, at: number = this.now()): void {
    if (m === 'speechEnd') {
      this.#t.clear();
      this.#t.set(m, at);
      return;
    }
    if (!this.#t.has('speechEnd') || this.#t.has(m)) return;
    const need = NEEDS[m];
    if (need && !this.#t.has(need)) return;
    this.#t.set(m, at);
    if (m === 'firstAudio') this.#report();
  }

  #gap(a: TurnMark, b: TurnMark): string {
    const x = this.#t.get(a);
    const y = this.#t.get(b);
    return x !== undefined && y !== undefined ? `${Math.max(0, y - x)} ms` : 'n/a';
  }

  #report(): void {
    const t = this.#t;
    const total = t.has('speechEnd') && t.has('firstAudio') ? `${t.get('firstAudio')! - t.get('speechEnd')!} ms` : 'n/a';
    this.log(
      `turn timing: speech end -> commit ${this.#gap('speechEnd', 'commit')}; commit -> final text ${this.#gap('commit', 'final')}; ` +
        `final -> first model text ${this.#gap('final', 'firstText')}; speech synthesis first chunk ${this.#gap('ttsStart', 'ttsChunk')}; ` +
        `synthesis total ${this.#gap('ttsStart', 'ttsDone')}; first chunk -> first audio ${this.#gap('ttsChunk', 'firstAudio')}; TOTAL speech end -> first audio ${total}`,
    );
    this.#t.clear();
  }
}
