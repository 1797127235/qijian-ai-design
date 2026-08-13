import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileGcScheduler } from "./file-gc-scheduler.js";

function emptyResult() {
  return { scanned: 0, deleted: 0, skipped: 0, errors: 0 };
}

describe("FileGcScheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("merges many schedules for one project into a single sweep", async () => {
    const gc = vi.fn(async () => emptyResult());
    const scheduler = new FileGcScheduler({ gc, debounceMs: 500 });
    for (let i = 0; i < 11; i += 1) scheduler.schedule("p1");
    expect(gc).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(gc).toHaveBeenCalledTimes(1);
    expect(gc).toHaveBeenCalledWith("p1");
  });

  it("sweeps different projects independently", async () => {
    const gc = vi.fn(async () => emptyResult());
    const scheduler = new FileGcScheduler({ gc, debounceMs: 500 });
    scheduler.schedule("p1");
    scheduler.schedule("p2");
    await vi.advanceTimersByTimeAsync(500);
    expect(gc).toHaveBeenCalledTimes(2);
    expect(gc).toHaveBeenCalledWith("p1");
    expect(gc).toHaveBeenCalledWith("p2");
  });

  it("does not start a second sweep while one is running; reruns once if dirtied", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gc = vi.fn(async () => {
      await gate;
      return emptyResult();
    });
    const scheduler = new FileGcScheduler({ gc, debounceMs: 500 });
    scheduler.schedule("p1");
    await vi.advanceTimersByTimeAsync(500);
    expect(gc).toHaveBeenCalledTimes(1);
    scheduler.schedule("p1");
    await vi.advanceTimersByTimeAsync(500);
    expect(gc).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(gc).toHaveBeenCalledTimes(2);
  });

  it("cancel drops a pending sweep", async () => {
    const gc = vi.fn(async () => emptyResult());
    const scheduler = new FileGcScheduler({ gc, debounceMs: 500 });
    scheduler.schedule("p1");
    scheduler.cancel("p1");
    await vi.advanceTimersByTimeAsync(500);
    expect(gc).not.toHaveBeenCalled();
  });
});
