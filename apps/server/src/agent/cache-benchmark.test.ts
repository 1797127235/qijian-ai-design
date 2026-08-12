import { describe, expect, it } from "vitest";
import {
  DEFAULT_CACHE_BENCHMARK_THRESHOLDS,
  summarizeCacheBenchmark,
  type CacheBenchmarkModelTurn,
} from "./cache-benchmark.js";

function turn(
  scenarioId: string,
  runIndex: number,
  cohort: CacheBenchmarkModelTurn["cohort"],
  usage: Pick<CacheBenchmarkModelTurn["usage"], "input" | "cacheRead" | "cacheWrite">,
): CacheBenchmarkModelTurn {
  return {
    scenarioId,
    runIndex,
    modelTurnIndex: 1,
    cohort,
    turnKind: cohort === "eligible" ? "steady_user" : "thread_first",
    usage: {
      ...usage,
      output: 10,
      totalTokens: usage.input + usage.cacheRead + 10,
    },
  };
}

describe("summarizeCacheBenchmark", () => {
  it("uses token-weighted aggregation instead of averaging percentages", () => {
    const report = summarizeCacheBenchmark([
      turn("steady", 1, "eligible", { input: 10, cacheRead: 90, cacheWrite: 0 }),
      turn("steady", 2, "eligible", { input: 100, cacheRead: 0, cacheWrite: 0 }),
    ]);

    expect(report.eligible.readHitRate).toBeCloseTo(90 / 200);
    expect(report.eligible.turnPassRate).toBe(0.5);
    expect(report.eligible.severeMissRate).toBe(0.5);
    expect(report.eligible.turns).toBe(2);
  });

  it("keeps cold and epoch-boundary traffic out of the stable eligible cohort", () => {
    const report = summarizeCacheBenchmark([
      turn("steady", 1, "cold", { input: 2_000, cacheRead: 0, cacheWrite: 500 }),
      turn("steady", 2, "epoch_boundary", { input: 1_000, cacheRead: 1_000, cacheWrite: 0 }),
      turn("steady", 3, "eligible", { input: 100, cacheRead: 1_900, cacheWrite: 0 }),
    ]);

    expect(report.allTraffic.turns).toBe(3);
    expect(report.eligible.turns).toBe(1);
    expect(report.eligible.readHitRate).toBeCloseTo(0.95);
    expect(report.byScenario.steady.eligible.turns).toBe(1);
  });

  it("fails closed when the provider exposes no cache signal", () => {
    const report = summarizeCacheBenchmark([
      turn("steady", 1, "eligible", { input: 100, cacheRead: 0, cacheWrite: 0 }),
    ]);

    expect(report.cacheSignal).toBe(false);
    expect(report.verdict).toBe("fail");
    expect(report.checks.find((check) => check.id === "provider_cache_signal")).toMatchObject({
      passed: false,
    });
  });

  it("passes only when all default 90% cache SLO checks pass", () => {
    const report = summarizeCacheBenchmark([
      turn("steady", 1, "cold", { input: 100, cacheRead: 0, cacheWrite: 0 }),
      ...Array.from({ length: 10 }, (_, index) => turn(
        "steady",
        index + 2,
        "eligible",
        { input: 50, cacheRead: 950, cacheWrite: 0 },
      )),
    ]);

    expect(DEFAULT_CACHE_BENCHMARK_THRESHOLDS).toMatchObject({
      eligibleReadHitRate: 0.92,
      eligibleTurnHitRate: 0.9,
      eligibleTurnPassRate: 0.9,
    });
    expect(report.verdict).toBe("pass");
    expect(report.checks.filter((check) => check.required).every((check) => check.passed)).toBe(true);
    expect(report.checks.find((check) => check.id === "all_traffic_effective_reuse_rate")?.required).toBe(false);
  });
});
