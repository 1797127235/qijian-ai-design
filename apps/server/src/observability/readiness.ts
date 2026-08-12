import type { ReadinessResult } from "../http/app.js";
import type { RuntimeMetrics } from "./metrics.js";

type DatabaseProbe = { query: (sql: string) => Promise<unknown> };
type QueueProbe = { health: () => Promise<{ redis: boolean; workers: number }> };

export class RuntimeReadiness {
  constructor(
    private readonly database: DatabaseProbe,
    private readonly queue: QueueProbe,
    private readonly metrics?: RuntimeMetrics,
  ) {}

  async check(): Promise<ReadinessResult> {
    const [database, queue] = await Promise.allSettled([
      this.database.query("select 1"),
      this.queue.health(),
    ]);
    const postgres = database.status === "fulfilled";
    const redis = queue.status === "fulfilled" && queue.value.redis;
    const worker = queue.status === "fulfilled" && queue.value.workers > 0;
    this.metrics?.setReady("postgres", postgres);
    this.metrics?.setReady("redis", redis);
    this.metrics?.setReady("worker", worker);
    return {
      ok: postgres && redis && worker,
      checks: { postgres, redis, worker },
    };
  }
}
