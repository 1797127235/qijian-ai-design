/**
 * Agent 工具：查询异步 job 状态。
 *  - LLM 拿到 accepted 后想确认是否完成时调用
 *  - 跨项目查不到（where project_id=xxx 守卫），不暴露其他项目的 job
 */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { fail, ok, type ToolContext } from "./shared.js";

const parameters = Type.Object({
  task_id: Type.String({
    description: "异步任务 id（generate_from_desk 返回的 task_id）",
    minLength: 1,
  }),
});

export function createGetTaskTool(ctx: ToolContext) {
  return defineTool({
    name: "get_task",
    label: "查询后台任务",
    description:
      "查询 Agent 异步任务状态（accepted/running/succeeded/failed/cancelled）。"
      + "在 generate_from_desk 返回 task_id 后，需要确认是否完成时调用。",
    promptSnippet: "get_task — 查询异步任务状态",
    promptGuidelines: [
      "仅在有 task_id 且需要确认后台进度时调用 get_task。",
      "status 为 accepted/running 时不要声称已完成。",
    ],
    parameters,
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      const taskId = params.task_id.trim();
      if (!taskId) return fail("task_id 不能为空");
      const store = ctx.deps.jobStore;
      if (!store) return fail("任务存储未就绪");

      const job = await store.get(ctx.projectId, taskId);
      if (!job) return fail("未找到任务（可能不属于当前项目）", { task_id: taskId });

      const publicError = job.error
        ? (/取消|超时|中断/.test(job.error) ? job.error.slice(0, 80) : "任务失败")
        : undefined;
      const text = [
        `任务 ${job.id}（${job.kind}）状态=${job.status}`,
        job.artifactId ? `artifact_id=${job.artifactId}` : null,
        publicError ? `error=${publicError}` : null,
      ].filter(Boolean).join("；");

      return ok(text, {
        task_id: job.id,
        kind: job.kind,
        status: job.status,
        artifact_id: job.artifactId,
        error: publicError,
      });
    },
  });
}
