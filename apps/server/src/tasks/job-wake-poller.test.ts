import { describe, expect, it, vi } from "vitest";
import type { AgentJobDto } from "../agent/async-job/types.js";
import { TaskJobWakePoller } from "./job-wake-poller.js";

describe("TaskJobWakePoller", () => {
  it("consumes persistent terminal events in sequence", async () => {
    const taskId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const events = [
      { id: 1, taskId, projectId, eventKey: "accepted", type: "task.accepted", payload: {}, createdAt: new Date() },
      { id: 2, taskId, projectId, eventKey: "terminal", type: "task.terminal", payload: {}, createdAt: new Date() },
    ];
    const job = {
      id: taskId,
      projectId,
      threadId: crypto.randomUUID(),
      kind: "generate_from_desk",
      status: "succeeded",
      input: {},
      createdAt: new Date().toISOString(),
    } as AgentJobDto;
    const onJobTerminal = vi.fn();
    const poller = new TaskJobWakePoller(
      { listGlobalAfter: async (cursor) => events.filter((event) => event.id > cursor) },
      { get: async () => job },
      { onJobTerminal },
    );

    expect(await poller.pollOnce()).toEqual({ scanned: 2, terminal: 1, cursor: 2 });
    expect(await poller.pollOnce()).toEqual({ scanned: 0, terminal: 0, cursor: 2 });
    expect(onJobTerminal).toHaveBeenCalledOnce();
  });
});
