/** Inbox that batches messages arriving during an inference turn (§2.1 batching). */
export class Inbox<T> {
  private items: T[] = [];
  private waiters: (() => void)[] = [];
  push(item: T) {
    this.items.push(item);
    this.waiters.splice(0).forEach((w) => w());
  }
  get size() {
    return this.items.length;
  }
  /** Take everything queued (a batch). Waits if empty. */
  async drain(): Promise<T[]> {
    if (this.items.length === 0) await new Promise<void>((r) => this.waiters.push(r));
    return this.items.splice(0);
  }
  drainNow(): T[] {
    return this.items.splice(0);
  }
}
