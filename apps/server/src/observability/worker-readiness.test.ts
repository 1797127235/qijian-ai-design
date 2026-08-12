import { describe, expect, it, vi } from "vitest";
import { RuntimeMetrics } from "./metrics.js";
import { WorkerRuntimeReadiness } from "./worker-readiness.js";

describe("WorkerRuntimeReadiness", () => {
  it("reports ready when PostgreSQL, Redis, and the worker are live", async () => {
    const readiness = new WorkerRuntimeReadiness(
      { query: vi.fn().mockResolvedValue({}) },
      { pingRedis: vi.fn().mockResolvedValue(true), isRunning: () => true },
    );

    await expect(readiness.check()).resolves.toEqual({
      ok: true,
      checks: { postgres: true, redis: true, worker: true },
    });
  });

  it("does not treat an in-memory running flag as Redis readiness", async () => {
    const metrics = new RuntimeMetrics("test-worker", { defaultMetrics: false });
    const readiness = new WorkerRuntimeReadiness(
      { query: vi.fn().mockResolvedValue({}) },
      { pingRedis: vi.fn().mockResolvedValue(false), isRunning: () => true },
      metrics,
    );

    await expect(readiness.check()).resolves.toEqual({
      ok: false,
      checks: { postgres: true, redis: false, worker: false },
    });
    const output = await metrics.text();
    expect(output).toContain('qijian_subsystem_ready{subsystem="redis",service="test-worker"} 0');
    expect(output).toContain('qijian_subsystem_ready{subsystem="worker",service="test-worker"} 0');
  });
});
