import { describe, expect, it, vi } from "vitest";
import { ImageTaskExecutor } from "./image-task-executor.js";
import type { ImageGenerateTaskV1 } from "./types.js";

function task(overrides: Partial<ImageGenerateTaskV1> = {}): ImageGenerateTaskV1 {
  return {
    schema_version: 1,
    kind: "image.generate",
    operation: "spawn",
    project_id: "proj-1",
    task_id: "task-1",
    references: [],
    target_version: 1,
    prompt: "composed",
    user_prompt: "user",
    model: "fake",
    origin: { type: "panel", name: "test" },
    ...overrides,
  };
}

describe("ImageTaskExecutor.failPending", () => {
  it("appends a non-pending error payload so UI leaves generating state", async () => {
    const append = vi.fn(async () => ({ id: "v2" }));
    const executor = new ImageTaskExecutor(
      {} as never,
      {} as never,
      { append } as never,
    );

    await executor.failPending("art-1", task(), "provider 503");

    expect(append).toHaveBeenCalledWith("art-1", expect.objectContaining({
      status: "draft",
      createdBy: "designer",
      payload: expect.objectContaining({
        pending: false,
        error: "provider 503",
        prompt: "composed",
        user_prompt: "user",
        model: "fake",
      }),
    }));
  });

  it("swallows append failures (best-effort)", async () => {
    const executor = new ImageTaskExecutor(
      {} as never,
      {} as never,
      { append: async () => { throw new Error("gone"); } } as never,
    );
    await expect(executor.failPending("art-1", task(), "x")).resolves.toBeUndefined();
  });
});
