import { describe, expect, it, vi } from "vitest";
import { createGetTaskTool } from "./get-task.js";
import type { ToolContext } from "./shared.js";

function textOf(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content.map((part) => ("text" in part ? part.text : "")).join("");
}

describe("get_task", () => {
  it("surfaces stored job error instead of generic 任务失败", async () => {
    const get = vi.fn().mockResolvedValue({
      id: "job-1",
      kind: "generate_from_desk",
      status: "failed",
      artifactId: "fx-1",
      error: "图像服务调用失败（HTTP 500）：upstream error: do request failed",
    });
    const ctx = {
      projectId: "p1",
      deps: { jobStore: { get } },
    } as unknown as ToolContext;

    const tool = createGetTaskTool(ctx);
    const result = await tool.execute("c1", { task_id: "job-1" }, undefined, undefined, {} as never);

    expect(textOf(result)).toContain("HTTP 500");
    expect(textOf(result)).toContain("do request failed");
    expect(textOf(result)).not.toMatch(/error=任务失败$/);
    expect(result.details).toMatchObject({
      status: "failed",
      error: expect.stringContaining("HTTP 500"),
    });
  });

  it("returns not found for missing job", async () => {
    const ctx = {
      projectId: "p1",
      deps: { jobStore: { get: vi.fn().mockResolvedValue(null) } },
    } as unknown as ToolContext;
    const tool = createGetTaskTool(ctx);
    const result = await tool.execute("c2", { task_id: "missing" }, undefined, undefined, {} as never);
    expect(textOf(result)).toContain("未找到任务");
  });
});
