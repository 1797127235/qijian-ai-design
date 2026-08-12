import { describe, expect, it } from "vitest";
import { CACHE_BENCHMARK_SCENARIOS } from "./cache-benchmark-scenarios.js";

describe("CACHE_BENCHMARK_SCENARIOS", () => {
  it("uses unique stable ids and includes enough eligible turns per scenario", () => {
    const ids = CACHE_BENCHMARK_SCENARIOS.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const scenario of CACHE_BENCHMARK_SCENARIOS) {
      expect(scenario.turns[0]).toMatchObject({ cohort: "cold", turnKind: "thread_first" });
      expect(scenario.turns.filter((turn) => turn.cohort === "eligible").length).toBeGreaterThanOrEqual(5);
    }
  });

  it("covers dialogue, skills, tool use, Desk changes, large resync and image generation", () => {
    expect(CACHE_BENCHMARK_SCENARIOS.map((scenario) => scenario.setup.kind)).toEqual(expect.arrayContaining([
      "empty",
      "large_desk",
      "mutable_desk",
    ]));
    expect(CACHE_BENCHMARK_SCENARIOS.some((scenario) => scenario.turns.some((turn) => (
      turn.requiredTools?.includes("record_project_memory")
    )))).toBe(true);
    expect(CACHE_BENCHMARK_SCENARIOS.some((scenario) => scenario.turns.some((turn) => turn.waitForJob))).toBe(true);
    expect(CACHE_BENCHMARK_SCENARIOS.some((scenario) => scenario.turns.some((turn) => (
      turn.prompt.includes("$design-language")
    )))).toBe(true);
  });
});
