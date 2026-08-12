import { describe, expect, it, vi } from "vitest";
import { RuntimeReadiness } from "./readiness.js";

describe("RuntimeReadiness", () => {
  it("requires PostgreSQL, Redis, and at least one BullMQ worker", async () => {
    const readiness = new RuntimeReadiness(
      { query: vi.fn(async () => ({ rows: [{ ok: 1 }] })) },
      { health: vi.fn(async () => ({ redis: true, workers: 1 })) },
    );

    await expect(readiness.check()).resolves.toEqual({
      ok: true,
      checks: { postgres: true, redis: true, worker: true },
    });
  });

  it("reports a missing worker without hiding healthy dependencies", async () => {
    const readiness = new RuntimeReadiness(
      { query: vi.fn(async () => ({ rows: [{ ok: 1 }] })) },
      { health: vi.fn(async () => ({ redis: true, workers: 0 })) },
    );

    await expect(readiness.check()).resolves.toEqual({
      ok: false,
      checks: { postgres: true, redis: true, worker: false },
    });
  });

  it("turns dependency exceptions into readiness state", async () => {
    const readiness = new RuntimeReadiness(
      { query: vi.fn(async () => { throw new Error("postgres down"); }) },
      { health: vi.fn(async () => { throw new Error("redis down"); }) },
    );

    await expect(readiness.check()).resolves.toEqual({
      ok: false,
      checks: { postgres: false, redis: false, worker: false },
    });
  });
});
