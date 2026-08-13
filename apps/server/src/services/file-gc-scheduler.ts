/**
 * 文件孤儿 GC 调度：按项目合并触发，全项目单飞。
 * 删卡只标记脏；真正扫库发生在防抖窗口之后，且同一项目不会并行进池。
 */
export const FILE_GC_DEBOUNCE_MS = 500;

export type FileGcResult = {
  scanned: number;
  deleted: number;
  skipped: number;
  errors: number;
};

export type FileGcSchedulerDeps = {
  gc: (projectId: string) => Promise<FileGcResult>;
  debounceMs?: number;
  onFinished?: (projectId: string, result: FileGcResult) => void;
  onError?: (projectId: string, error: unknown) => void;
};

export class FileGcScheduler {
  private readonly debounceMs: number;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly running = new Set<string>();
  private readonly dirty = new Set<string>();

  constructor(private readonly deps: FileGcSchedulerDeps) {
    this.debounceMs = deps.debounceMs ?? FILE_GC_DEBOUNCE_MS;
  }

  /** 删卡后调用：窗口内多次合并成一次扫描。正在扫则只记 dirty，扫完再跑一轮。 */
  schedule(projectId: string) {
    this.dirty.add(projectId);
    if (this.running.has(projectId)) return;
    const existing = this.timers.get(projectId);
    if (existing) clearTimeout(existing);
    this.timers.set(
      projectId,
      setTimeout(() => {
        this.timers.delete(projectId);
        void this.flush(projectId);
      }, this.debounceMs),
    );
  }

  /** 项目删除或关停时取消待扫，避免对已删项目进池。 */
  cancel(projectId: string) {
    const existing = this.timers.get(projectId);
    if (existing) clearTimeout(existing);
    this.timers.delete(projectId);
    this.dirty.delete(projectId);
  }

  cancelAll() {
    for (const projectId of [...this.timers.keys()]) this.cancel(projectId);
  }

  private async flush(projectId: string) {
    if (this.running.has(projectId)) {
      this.dirty.add(projectId);
      return;
    }
    this.running.add(projectId);
    try {
      do {
        this.dirty.delete(projectId);
        try {
          const result = await this.deps.gc(projectId);
          this.deps.onFinished?.(projectId, result);
        } catch (error) {
          this.deps.onError?.(projectId, error);
        }
      } while (this.dirty.has(projectId));
    } finally {
      this.running.delete(projectId);
    }
  }
}
