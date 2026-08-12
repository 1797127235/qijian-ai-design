import { describe, expect, it } from "vitest";
import {
  addUsageSample,
  emptyUsageAggregate,
  effectiveReuseRate,
  hitRate,
  sampleFromMessageEndEvent,
  sampleFromUsage,
} from "./usage-metrics.js";

describe("usage-metrics", () => {
  it("computes hitRate as cacheRead/(input+cacheRead)", () => {
    expect(hitRate(100, 400)).toBeCloseTo(0.8);
    expect(hitRate(0, 0)).toBeNull();
    expect(hitRate(50, 0)).toBe(0);
  });

  it("computes effective reuse including cache writes", () => {
    expect(effectiveReuseRate(100, 400, 50)).toBeCloseTo(400 / 550);
    expect(effectiveReuseRate(0, 0, 0)).toBeNull();
  });

  it("parses pi usage object", () => {
    const s = sampleFromUsage({
      input: 100,
      output: 20,
      cacheRead: 400,
      cacheWrite: 10,
      totalTokens: 520,
    });
    expect(s?.hitRate).toBeCloseTo(0.8);
    expect(s?.effectiveReuseRate).toBeCloseTo(400 / 510);
    expect(s?.cacheRead).toBe(400);
  });

  it("extracts usage from message_end", () => {
    const s = sampleFromMessageEndEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        usage: { input: 10, output: 5, cacheRead: 90, cacheWrite: 0, totalTokens: 105 },
      },
    });
    expect(s?.input).toBe(10);
    expect(s?.cacheRead).toBe(90);
    expect(s?.hitRate).toBeCloseTo(0.9);
  });

  it("ignores non-assistant message_end", () => {
    expect(sampleFromMessageEndEvent({
      type: "message_end",
      message: { role: "user", usage: { input: 1, cacheRead: 1 } },
    })).toBeNull();
  });

  it("aggregates multi-turn usage", () => {
    let agg = emptyUsageAggregate();
    agg = addUsageSample(agg, sampleFromUsage({
      input: 100, output: 10, cacheRead: 0, cacheWrite: 50, totalTokens: 110,
    })!);
    agg = addUsageSample(agg, sampleFromUsage({
      input: 50, output: 10, cacheRead: 400, cacheWrite: 0, totalTokens: 460,
    })!);
    expect(agg.turns).toBe(2);
    expect(agg.input).toBe(150);
    expect(agg.cacheRead).toBe(400);
    expect(agg.hitRate).toBeCloseTo(400 / 550);
    expect(agg.effectiveReuseRate).toBeCloseTo(400 / 600);
    expect(agg.cacheSignal).toBe(true);
  });
});
