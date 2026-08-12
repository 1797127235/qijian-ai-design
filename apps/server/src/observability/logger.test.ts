import { describe, expect, it, vi } from "vitest";
import { StructuredLogger } from "./logger.js";

describe("StructuredLogger", () => {
  it("emits a stable JSON event with correlation fields", () => {
    const sink = vi.fn();
    const logger = new StructuredLogger("api", { sink });

    logger.info("task_finished", { request_id: "req-1", task_id: "task-1", status: "succeeded" });

    const parsed = JSON.parse(sink.mock.calls[0][0]);
    expect(parsed).toMatchObject({
      level: "info",
      service: "api",
      event: "task_finished",
      request_id: "req-1",
      task_id: "task-1",
      status: "succeeded",
    });
    expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("redacts sensitive fields before writing", () => {
    const sink = vi.fn();
    const logger = new StructuredLogger("api", { sink });

    logger.warn("provider_failed", { authorization: "Bearer secret", api_key: "secret", message: "safe" });

    const parsed = JSON.parse(sink.mock.calls[0][0]);
    expect(parsed.authorization).toBe("[redacted]");
    expect(parsed.api_key).toBe("[redacted]");
    expect(parsed.message).toBe("safe");
  });
});
