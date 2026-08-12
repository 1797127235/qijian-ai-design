/** 有界出站队列：满则 drop 最旧；永不阻塞调用方。 */

export type QueueTask = () => Promise<void>;

export class BoundedAsyncQueue {
  private readonly q: QueueTask[] = [];
  private active = 0;
  private dropped = 0;

  constructor(
    private readonly maxSize: number,
    private readonly concurrency = 2,
    private readonly onDrop?: (droppedTotal: number) => void,
  ) {}

  get size() { return this.q.length; }
  get droppedCount() { return this.dropped; }

  enqueue(task: QueueTask) {
    if (this.q.length >= this.maxSize) {
      this.q.shift();
      this.dropped += 1;
      this.onDrop?.(this.dropped);
    }
    this.q.push(task);
    this.pump();
  }

  private pump() {
    while (this.active < this.concurrency && this.q.length > 0) {
      const task = this.q.shift()!;
      this.active += 1;
      // Promise.resolve().then 包一层，同步 throw 也走 catch/finally，避免 active 泄漏
      void Promise.resolve()
        .then(task)
        .catch(() => undefined)
        .finally(() => {
          this.active -= 1;
          this.pump();
        });
    }
  }

  /** @returns true 若在超时前排空；false 表示仍有排队/进行中任务 */
  async drain(timeoutMs = 2_000): Promise<boolean> {
    const start = Date.now();
    while ((this.q.length > 0 || this.active > 0) && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return this.q.length === 0 && this.active === 0;
  }
}
