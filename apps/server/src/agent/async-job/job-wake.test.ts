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
    }));
  });

  it("skips panel jobs without thread", async () => {
    const appendPrompt = vi.fn();
    const deliver = vi.fn();
    const svc = new JobWakeService({ appendPrompt } as never, deliver, () => false);
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
    const svc = new JobWakeService({ appendPrompt } as never, deliver, () => false);
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
    let busy = false;
    const svc = new JobWakeService(
      { appendPrompt } as never,
      deliver,
      () => busy,
    );
    svc.onJobTerminal(job());
    await vi.waitFor(() => expect(appendPrompt).toHaveBeenCalled());
    // first attempt failed busy — still in queue; force drain
    svc.notifyThreadIdle("p1", "t1");
    await vi.waitFor(() => expect(deliver).toHaveBeenCalled());
  });
});
