import { describe, expect, it, vi } from "vitest";
import { TaskDeskRefreshPoller } from "./desk-refresh-poller.js";

describe("TaskDeskRefreshPoller", () => {
  it("publishes object_changed for image and name terminal events", async () => {
    const projectId = crypto.randomUUID();
    const imageTaskId = crypto.randomUUID();
    const nameTaskId = crypto.randomUUID();
    const artifactId = crypto.randomUUID();
    const events = [
      {
        id: 1,
        taskId: imageTaskId,
        projectId,
        eventKey: "a",
        type: "task.accepted",
        payload: {},
        createdAt: new Date(),
      },
      {
        id: 2,
        taskId: imageTaskId,
        projectId,
        eventKey: "t-image",
        type: "task.terminal",
        payload: { status: "succeeded" },
        createdAt: new Date(),
      },
      {
        id: 3,
        taskId: nameTaskId,
        projectId,
        eventKey: "t-name",
        type: "task.terminal",
        payload: { status: "succeeded" },
        createdAt: new Date(),
      },
    ];
    const publish = vi.fn();
    const poller = new TaskDeskRefreshPoller(
      { listGlobalAfter: async (cursor) => events.filter((event) => event.id > cursor) },
      {
        get: async (taskId) => {
          if (taskId === imageTaskId) {
            return { id: imageTaskId, projectId, taskRole: "image", artifactId } as never;
          }
          if (taskId === nameTaskId) {
            return { id: nameTaskId, projectId, taskRole: "name", artifactId } as never;
          }
          return undefined;
        },
      },
      publish,
    );

    expect(await poller.pollOnce()).toEqual({ scanned: 3, published: 2, cursor: 3 });
    expect(await poller.pollOnce()).toEqual({ scanned: 0, published: 0, cursor: 3 });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenNthCalledWith(1, {
      type: "object_changed",
      projectId,
      artifactId,
    });
    expect(publish).toHaveBeenNthCalledWith(2, {
      type: "object_changed",
      projectId,
      artifactId,
    });
  });

  it("skips terminal events when task row is missing", async () => {
    const projectId = crypto.randomUUID();
    const events = [
      {
        id: 9,
        taskId: crypto.randomUUID(),
        projectId,
        eventKey: "gone",
        type: "task.terminal",
        payload: {},
        createdAt: new Date(),
      },
    ];
    const publish = vi.fn();
    const poller = new TaskDeskRefreshPoller(
      { listGlobalAfter: async () => events },
      { get: async () => undefined },
      publish,
    );
    expect(await poller.pollOnce()).toEqual({ scanned: 1, published: 0, cursor: 9 });
    expect(publish).not.toHaveBeenCalled();
  });
});
