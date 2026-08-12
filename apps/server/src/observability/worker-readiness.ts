import type { RuntimeMetrics } from "./metrics.js";

type DatabaseProbe = { query: (sql: string) => Promise<unknown> };
type WorkerProbe = { pingRedis: () => Promise<boolean>; isRunning: () => boolean };

export class WorkerRuntimeReadiness {
  constructor(
    private readonly database: DatabaseProbe,
    private readonly worker: WorkerProbe,
    private readonly metrics?: RuntimeMetrics,
  ) {}

  async check() {
    const [database, redisProbe] = await Promise.allSettled([
      this.database.query("select 1"),
      this.worker.pingRedis(),
    ]);
    const postgres = database.status === "fulfilled";
    const redis = redisProbe.status === "fulfilled" && redisProbe.value;
    const worker = redis && this.worker.isRunning();
    const checks = { postgres, redis, worker };
    for (const [subsystem, ready] of Object.entries(checks)) {
      this.metrics?.setReady(subsystem, ready);
    }
    return { ok: postgres && redis && worker, checks };
  }
}
