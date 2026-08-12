import { describe, expect, it, vi } from "vitest";
import { TraceRegistry } from "./registry.js";

describe("TraceRegistry", () => {
  it("registers a wake run as a child of the persisted source trace", () => {
    const linked = { id: "wake-span", runId: "wake-run" };
    const tracer = {
      enabled: true,
      startRoot: vi.fn(),
      startSpan: vi.fn(() => linked),
      end: vi.fn(),
      annotate: vi.fn(),
      recordError: vi.fn(),
      flush: vi.fn(),
    };
    const registry = new TraceRegistry(tracer as never);

    const context = registry.startLinkedRoot({
      project_id: "project-1",
      thread_id: "thread-1",
      run_id: "wake-run",
      inputs: { wake: true },
    }, "source-root");

    expect(context.root).toBe(linked);
    expect(tracer.startSpan).toHaveBeenCalledWith(
      { id: "source-root", runId: "wake-run" },
      expect.objectContaining({ name: "agent.job_wake" }),
    );
  });

  it("patches an existing span with late token context", () => {
    const tracer = {
      enabled: true,
      startRoot: vi.fn(() => ({ id: "root", runId: "run-1" })),
      startSpan: vi.fn(),
      end: vi.fn(),
      annotate: vi.fn(),
      recordError: vi.fn(),
      flush: vi.fn(),
    };
    const registry = new TraceRegistry(tracer as never);
    const handle = { id: "tool-1", runId: "run-1" };

    registry.annotate(handle, { prompt_tokens_after: 1_200, prompt_token_delta: 180 });

    expect(tracer.annotate).toHaveBeenCalledWith(handle, {
      prompt_tokens_after: 1_200,
      prompt_token_delta: 180,
    });
  });
});
