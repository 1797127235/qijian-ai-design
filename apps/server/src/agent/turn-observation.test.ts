import { describe, expect, it } from "vitest";
import type { TraceHandle } from "./tracing/types.js";
import { AgentTurnObservation, summarizePayload } from "./turn-observation.js";
import { sampleFromUsage } from "./usage-metrics.js";

const span = (id: string): TraceHandle => ({ id, runId: "run-1" });
const usage = (input: number, cacheRead: number, cacheWrite: number, output = 10) => sampleFromUsage({
  input,
  output,
  cacheRead,
  cacheWrite,
  totalTokens: input + cacheRead + cacheWrite + output,
})!;

describe("AgentTurnObservation", () => {
  it("links a tool to its model turn and resolves provider token change on the next turn", () => {
    const observation = new AgentTurnObservation();
    expect(observation.startTurn("run-1")).toBe(0);
    observation.attachModelSpan(span("model-0"));
    expect(observation.completeModel(usage(100, 900, 20)).toolUpdates).toEqual([]);

    const tool = observation.startTool("call-1", span("tool-1"));
    expect(tool).toMatchObject({
      turnIndex: 0,
      modelSpan: { id: "model-0" },
      before: { input: 100, cacheRead: 900, cacheWrite: 20 },
      promptTokensBefore: 1_020,
    });
    observation.finishTool("call-1");

    expect(observation.startTurn("run-1")).toBe(1);
    observation.attachModelSpan(span("model-1"));
    const completed = observation.completeModel(usage(140, 1_060, 0));

    expect(completed.turnIndex).toBe(1);
    expect(completed.toolUpdates).toEqual([expect.objectContaining({
      toolCallId: "call-1",
      turnIndex: 0,
      promptTokensBefore: 1_020,
      promptTokensAfter: 1_200,
      promptTokenDelta: 180,
      batchSize: 1,
      after: expect.objectContaining({ cacheRead: 1_060, cacheWrite: 0 }),
    })]);
  });

  it("marks parallel tools as sharing one provider-accounted token transition", () => {
    const observation = new AgentTurnObservation();
    observation.startTurn("run-1");
    observation.completeModel(usage(50, 450, 0));
    observation.startTool("call-a", span("tool-a"));
    observation.startTool("call-b", span("tool-b"));
    observation.finishTool("call-a");
    observation.finishTool("call-b");
    observation.startTurn("run-1");

    const updates = observation.completeModel(usage(80, 620, 0)).toolUpdates;

    expect(updates).toHaveLength(2);
    expect(updates.every((update) => update.batchSize === 2)).toBe(true);
    expect(updates.every((update) => update.promptTokenDelta === 200)).toBe(true);
  });

  it("starts turn numbering from zero for a new product run", () => {
    const observation = new AgentTurnObservation();
    expect(observation.startTurn("run-1")).toBe(0);
    expect(observation.startTurn("run-1")).toBe(1);
    expect(observation.startTurn("run-2")).toBe(0);
  });
});

describe("summarizePayload", () => {
  it("returns size and shape without copying argument values", () => {
    const summary = summarizePayload({ prompt: "private design request", count: 2 });

    expect(summary).toMatchObject({ kind: "object", keys: ["prompt", "count"], keyCount: 2 });
    expect(summary.characters).toBeGreaterThan(0);
    expect(summary.bytes).toBeGreaterThan(0);
    expect(JSON.stringify(summary)).not.toContain("private design request");
  });

  it("degrades safely for circular payloads", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(summarizePayload(circular)).toMatchObject({
      kind: "object",
      serializationError: true,
    });
  });
});
