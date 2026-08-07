import { describe, expect, it, vi } from "vitest";
import { NoopTracer } from "./noop.js";
import { createAgentTracer } from "./index.js";
import type { ServerConfig } from "../../config.js";

describe("NoopTracer", () => {
  it("never throws and reports disabled", () => {
    const t = new NoopTracer();
    expect(t.enabled).toBe(false);
    const root = t.startRoot({
      project_id: "p",
      thread_id: "t",
      run_id: "r",
      inputs: { text: "hi" },
    });
    const child = t.startSpan(root, { name: "tool.x", run_type: "tool" });
    t.end(child, { status: "ok" });
    t.recordError(root, { error_code: "INTERNAL", message: "x" });
    expect(async () => t.flush()).not.toThrow();
  });

  it("createAgentTracer uses Noop when tracing off", () => {
    const tracer = createAgentTracer({
      langsmithTracing: false,
      langsmithApiKey: "secret",
      langsmithProject: "pi",
    } as ServerConfig);
    expect(tracer.enabled).toBe(false);
    expect(tracer).toBeInstanceOf(NoopTracer);
  });

  it("createAgentTracer uses Noop when key missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tracer = createAgentTracer({
      langsmithTracing: true,
      langsmithProject: "pi",
    } as ServerConfig);
    expect(tracer.enabled).toBe(false);
    warn.mockRestore();
  });
});
