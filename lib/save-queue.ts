export class SerializedSaveQueue<T> {
  private tail: Promise<void> = Promise.resolve();
  private sequence = 0;

  enqueue(value: T, writer: (value: T, sequence: number) => Promise<void>): Promise<void> {
    const sequence = ++this.sequence;
    const run = this.tail.then(() => writer(value, sequence));
    this.tail = run.catch(() => undefined);
    return run;
  }

  whenIdle(): Promise<void> {
    return this.tail;
  }
}
