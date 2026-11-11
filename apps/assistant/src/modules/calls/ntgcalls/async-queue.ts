/** Single-consumer async queue with optional drop-oldest bound. `close()` lets the consumer drain, then ends the iteration. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  #items: T[] = [];
  #wake: (() => void) | null = null;
  #closed = false;
  dropped = 0;
  constructor(private readonly maxItems = Infinity) {}
  push(item: T): void {
    if (this.#closed) return;
    if (this.#items.length >= this.maxItems) {
      this.#items.shift();
      this.dropped++;
    }
    this.#items.push(item);
    this.#wake?.();
  }
  close(): void {
    this.#closed = true;
    this.#wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      while (this.#items.length) yield this.#items.shift()!;
      if (this.#closed) return;
      await new Promise<void>((r) => {
        this.#wake = r;
      });
      this.#wake = null;
    }
  }
}
