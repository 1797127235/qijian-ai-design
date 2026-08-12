import { describe, expect, it, vi } from "vitest";
import { BoundedAsyncQueue } from "./queue.js";

describe("BoundedAsyncQueue telemetry", () => {
  it("reports every dropped trace export operation", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const onDrop = vi.fn();
    const queue = new BoundedAsyncQueue(1, 1, onDrop);
    queue.enqueue(() => blocked);
    queue.enqueue(async () => undefined);
    queue.enqueue(async () => undefined);

    expect(queue.droppedCount).toBe(1);
    expect(onDrop).toHaveBeenCalledWith(1);
    release();
    await queue.drain();
  });
});
