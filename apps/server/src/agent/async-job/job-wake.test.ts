import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../lib/errors.js";
import { JobWakeService } from "./job-wake.js";
import type { AgentJobDto } from "./types.js";

function job(patch: Partial<AgentJobDto> = {}): AgentJobDto {
  return {
    id: "job-1",
    projectId: "p1",
    threadId: "t1",
    kind: "generate_from_desk",
    status: "succeeded",
    input: { prompt: "hi" },
    artifactId: "fx-1",
    createdAt: new Date().toISOString(),
    ...patch,
  };
}

describe("JobWakeService", () => {
  it("delivers wake when thread idle", async () => {
    const appendPrompt = vi.fn().mockResolvedValue({
      created: true,
      run: { id: "run-1" },
      message: { text: "wake-text" },
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const svc = new JobWakeService(
      { appendPrompt } as never,
      deliver,
      () => false,
      0,
    );
    svc.onJobTerminal(job());
    await vi.waitFor(() => expect(deliver).toHaveBeenCalled());
    expect(appendPrompt).toHaveBeenCalledWith(
      "p1",
      "t1",
      expect.stringContaining("[JOB_EVENT]"),
      "job-wake:job-1",
      [],
    );
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "p1",
      threadId: "t1",
      taskId: "job-1",
      sourceTraceContext: undefined,
    }));
  });

  it("carries the originating trace context into the wake delivery", async () => {
    const appendPrompt = vi.fn().mockResolvedValue({
      created: true,
      run: { id: "run-wake" },
      message: { text: "wake" },
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const svc = new JobWakeService({ appendPrompt } as never, deliver, () => false, 0);

    const traceContext = {
      traceId: "root-original",
      parentRunId: "tool-original",
      langsmithTrace: "20260812T000000000001Zroot-original.20260812T000001000002Ztool-original",
    };
    svc.onJobTerminal(job({ traceContext }));

    await vi.waitFor(() => expect(deliver).toHaveBeenCalled());
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
      sourceTraceContext: traceContext,
    }));
  });

  it("skips panel jobs without thread", async () => {
    const appendPrompt = vi.fn();
    const deliver = vi.fn();
    const svc = new JobWakeService({ appendPrompt } as never, deliver, () => false, 0);
    svc.onJobTerminal(job({ threadId: undefined }));
    await new Promise((r) => setTimeout(r, 20));
    expect(appendPrompt).not.toHaveBeenCalled();
  });

  it("queues while busy then drains on idle", async () => {
    let busy = true;
    const appendPrompt = vi.fn().mockResolvedValue({
      created: true,
      run: { id: "run-1" },
      message: { text: "wake" },
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const svc = new JobWakeService(
      { appendPrompt } as never,
      deliver,
      () => busy,
      0,
    );
    svc.onJobTerminal(job());
    await new Promise((r) => setTimeout(r, 20));
    expect(deliver).not.toHaveBeenCalled();
    busy = false;
    svc.notifyThreadIdle("p1", "t1");
    await vi.waitFor(() => expect(deliver).toHaveBeenCalled());
  });

  it("does not re-deliver when appendPrompt reports not created", async () => {
    const appendPrompt = vi.fn().mockResolvedValue({
      created: false,
      message: { text: "old" },
    });
    const deliver = vi.fn();
    const svc = new JobWakeService({ appendPrompt } as never, deliver, () => false, 0);
    svc.onJobTerminal(job());
    await vi.waitFor(() => expect(appendPrompt).toHaveBeenCalled());
    expect(deliver).not.toHaveBeenCalled();
  });

  it("requeues on ATTACHMENT_BUSY", async () => {
    let calls = 0;
    const appendPrompt = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new AppError(409, "ATTACHMENT_BUSY", "busy", true);
      return { created: true, run: { id: "r" }, message: { text: "ok" } };
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const svc = new JobWakeService(
      { appendPrompt } as never,
      deliver,
      () => false,
      0,
    );
    svc.onJobTerminal(job());
    await vi.waitFor(() => expect(appendPrompt).toHaveBeenCalled());
    svc.notifyThreadIdle("p1", "t1");
    await vi.waitFor(() => expect(deliver).toHaveBeenCalled());
  });

  it("merges multiple terminal jobs into one wake", async () => {
    const appendPrompt = vi.fn().mockResolvedValue({
      created: true,
      run: { id: "run-b" },
      message: { text: "batch" },
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const svc = new JobWakeService({ appendPrompt } as never, deliver, () => false, 30);
    svc.onJobTerminal(job({ id: "job-a", status: "succeeded" }));
    svc.onJobTerminal(job({ id: "job-b", status: "cancelled", artifactId: "fx-2" }));
    await vi.waitFor(() => expect(appendPrompt).toHaveBeenCalledTimes(1));
    expect(appendPrompt.mock.calls[0][2]).toContain("[JOB_EVENT_BATCH]");
    expect(appendPrompt.mock.calls[0][3]).toMatch(/^job-wake-batch:/);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("does not drop queued jobs that are already inFlight", async () => {
    let resolveFirst!: () => void;
    const firstGate = new Promise<void>((r) => {
      resolveFirst = r;
    });
    let deliverCount = 0;
    const appendPrompt = vi.fn().mockResolvedValue({
      created: true,
      run: { id: "run-x" },
      message: { text: "w" },
    });
    const deliver = vi.fn().mockImplementation(async () => {
      deliverCount += 1;
      if (deliverCount === 1) await firstGate;
    });
    const svc = new JobWakeService({ appendPrompt } as never, deliver, () => false, 0);

    svc.onJobTerminal(job({ id: "job-slow", status: "succeeded" }));
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));

    // second terminal while first deliver still running
    svc.onJobTerminal(job({ id: "job-queued", status: "failed", artifactId: "fx-q" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(appendPrompt).toHaveBeenCalledTimes(1);

    resolveFirst();
    svc.notifyThreadIdle("p1", "t1");
    await vi.waitFor(() => expect(appendPrompt).toHaveBeenCalledTimes(2));
    expect(appendPrompt.mock.calls[1][3]).toBe("job-wake:job-queued");
  });
});
