/**
 * Agent 工具：查询异步 job 状态。
 *  - LLM 拿到 accepted 后想确认是否完成时调用
 *  - 失败时透传 job.error 的可公开文案（勿抹成「任务失败」）
 */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { publicJobErrorForAgent } from "../async-job/protocol.js";
import { fail, ok, type ToolContext } from "./shared.js";

const parameters = Type.Object({
  task_id: Type.String({
    description: "异步任务 id（generate_from_desk / replace_on_desk / text_to_image_on_desk 返回的 task_id）",
    minLength: 1,
  }),
});

export function createGetTaskTool(ctx: ToolContext) {
  return defineTool({
    name: "get_task",
    label: "查询后台任务",
    description:
      "查询 Agent 异步任务状态（accepted/running/succeeded/failed/cancelled）。"
      + "在生图工具返回 task_id 后，需要确认是否完成时调用。"
      + "failed 时 error 字段含可公开原因（如图像服务 HTTP 状态），请如实转告用户。",
    promptSnippet: "get_task — 查询异步任务状态",
    promptGuidelines: [
      "查询已知 task_id 的当前状态；优先依赖系统 [JOB_EVENT] 获知完成。",
      "status 为 accepted/running 时不要声称已完成。",
      "status=failed 时把 error 原文转告用户，不要只说「任务失败」。",
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

      const publicError = publicJobErrorForAgent(job.error);
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
