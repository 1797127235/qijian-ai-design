import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  CapabilityGate,
  TurnContextScope,
  guardToolDefinition,
  type TurnContext,
} from "./capability-gate.js";

function context(mode: "designer" | "wake", runId: string): TurnContext {
  return Object.freeze({
    projectId: "project-1",
    threadId: "thread-1",
    runId,
    source: mode === "wake" ? "job_event" : "interactive",
    mode,
    authority: mode === "wake" ? "system_event" : "user_explicit",
    policyRevision: "capability-gate-v1",
    selectedArtifactIds: Object.freeze(["artifact-1"]),
  });
}

describe("CapabilityGate", () => {
  it("allows read tools and rejects mutating tools during wake", () => {
    const gate = new CapabilityGate();
    expect(gate.decide(context("wake", "wake-1"), "look_at").allowed).toBe(true);
    expect(gate.decide(context("wake", "wake-1"), "read_context_resource").allowed).toBe(true);
    expect(gate.decide(context("wake", "wake-1"), "generate_from_desk")).toMatchObject({
      allowed: false,
      code: "WAKE_READ_ONLY",
    });
    expect(gate.decide(context("wake", "wake-1"), "search_tools").allowed).toBe(false);
  });

  it("keeps concurrent run contexts isolated", async () => {
    const scope = new TurnContextScope();
    const seen = await Promise.all([
      scope.run(context("designer", "run-a"), async () => {
        await Promise.resolve();
        return scope.current().runId;
      }),
      scope.run(context("wake", "run-b"), async () => {
        await Promise.resolve();
        return scope.current().runId;
      }),
    ]);
    expect(seen).toEqual(["run-a", "run-b"]);
  });

  it("blocks execution before a wake tool reaches its implementation", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "executed" }] });
    const tool = defineTool({
      name: "remove_from_desk",
      label: "remove",
      description: "remove",
      parameters: Type.Object({}),
      execute,
    });
    const scope = new TurnContextScope();
    const guarded = guardToolDefinition(tool, scope, new CapabilityGate());

    const result = await scope.run(context("wake", "wake-1"), () => (
      guarded.execute("call-1", {}, undefined, undefined, {} as never)
    ));

    expect(execute).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      ok: false,
      code: "WAKE_READ_ONLY",
      tool_name: "remove_from_desk",
    });
  });
});
