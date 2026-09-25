/** A push-based async iterable: producers call push()/end(), one consumer iterates. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((result: IteratorResult<T>) => void)[] = [];
  private failure: unknown;
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  /** End the queue with an error that the consumer will throw on its next read. */
  fail(error: unknown): void {
    if (this.closed) return; // errors after a clean end (e.g. teardown noise) are ignored
    this.failure = error;
    this.end();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.items.length) {
        yield this.items.shift()!;
        continue;
      }
      if (this.closed) {
        if (this.failure !== undefined) throw this.failure;
        return;
      }
      const result = await new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      if (result.done) {
        if (this.failure !== undefined) throw this.failure;
        return;
      }
      yield result.value;
    }
  }
}
