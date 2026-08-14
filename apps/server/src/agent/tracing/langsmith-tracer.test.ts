import { describe, expect, it, vi } from "vitest";
import { LangSmithTracer } from "./langsmith-tracer.js";

describe("LangSmithTracer propagation", () => {
  it("restores the remote parent trace before creating a child", () => {
    const tracer = new LangSmithTracer({
      langsmithApiKey: "test-key",
      langsmithProject: "pi",
      langsmithEndpoint: "https://api.smith.langchain.com",
      langsmithDebugSync: false,
    });
    const root = tracer.startRoot({ project_id: "p", thread_id: "t", run_id: "run-1" });
    const parent = tracer.startSpan(root, { name: "tool.generate", run_type: "tool" });
    const context = tracer.captureContext(parent);

    expect(context).toEqual(expect.objectContaining({
      traceId: root.id,
      parentRunId: parent.id,
    }));
    expect(context?.langsmithTrace.split(".")).toHaveLength(2);

    const remote = tracer.startRemoteSpan(context!, { name: "task.image.generate", run_type: "tool" }, "run-1");
    const remoteContext = tracer.captureContext(remote);
    expect(remoteContext).toEqual(expect.objectContaining({ traceId: root.id }));
    expect(remoteContext?.langsmithTrace.split(".")).toHaveLength(3);
  });

  it("waits for LangSmith SDK batches during flush", async () => {
    const tracer = new LangSmithTracer({
      langsmithApiKey: "test-key",
      langsmithProject: "pi",
      langsmithEndpoint: "https://api.smith.langchain.com",
      langsmithDebugSync: false,
    });
    const awaitPendingTraceBatches = vi.fn().mockResolvedValue(undefined);
    Object.assign(tracer as unknown as { client: object }, {
      client: { awaitPendingTraceBatches },
    });

    await tracer.flush();

    expect(awaitPendingTraceBatches).toHaveBeenCalledOnce();
  });

  it("rejects an unknown local parent before exporting a malformed child", () => {
    const tracer = new LangSmithTracer({
      langsmithApiKey: "test-key",
      langsmithProject: "pi",
      langsmithEndpoint: "https://api.smith.langchain.com",
      langsmithDebugSync: false,
    });

    expect(() => tracer.startSpan(
      { id: "missing-parent", runId: "run-1" },
      { name: "tool.orphan", run_type: "tool" },
    )).toThrow("unknown trace parent: missing-parent");
  });
});
