import { describe, expect, it, vi } from "vitest";
import { runTaskWithTrace } from "./task-tracing.js";

describe("runTaskWithTrace", () => {
  it("continues the persisted Agent trace across the Worker boundary", async () => {
    const span = { id: "worker-span", runId: "run-1" };
    const traceContext = {
      traceId: "root-1",
      parentRunId: "tool-1",
      langsmithTrace: "20260812T000000000001Zroot-1.20260812T000001000002Ztool-1",
      baggage: "langsmith-project=pi",
    };
    const tracer = {
      enabled: true,
      startRemoteSpan: vi.fn(() => span),
      end: vi.fn(),
      recordError: vi.fn(),
      flush: vi.fn(),
    };

    const result = await runTaskWithTrace(tracer as never, {
      id: "task-1",
      runId: "run-1",
      kind: "generate_from_desk",
      traceContext,
    }, async () => ({ status: "succeeded", artifactId: "artifact-1" }));

    expect(result.status).toBe("succeeded");
    expect(tracer.startRemoteSpan).toHaveBeenCalledWith(
      traceContext,
      expect.objectContaining({ name: "task.generate_from_desk", run_type: "tool" }),
      "run-1",
    );
    expect(tracer.end).toHaveBeenCalledWith(span, expect.objectContaining({
      status: "ok",
      outputs: expect.objectContaining({ status: "succeeded" }),
    }));
  });

  it("marks terminal task failures on the Worker span", async () => {
    const span = { id: "worker-span", runId: "run-2" };
    const tracer = {
      enabled: true,
      startRemoteSpan: vi.fn(() => span),
      end: vi.fn(),
      recordError: vi.fn(),
      flush: vi.fn(),
    };

    await runTaskWithTrace(tracer as never, {
      id: "task-2",
      runId: "run-2",
      kind: "generate_from_desk",
      traceContext: {
        traceId: "root-2",
        parentRunId: "root-2",
        langsmithTrace: "20260812T000000000001Zroot-2",
      },
    }, async () => ({ status: "needs_review", error: "provider result unknown" }));

    expect(tracer.recordError).toHaveBeenCalledWith(span, expect.objectContaining({
      error_code: "INTERNAL",
      message: "provider result unknown",
    }));
  });
});
