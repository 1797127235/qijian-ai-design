/**
 * 异步 job 完成事件：结构化 observation，供 wake 注入轨迹。
 * 对齐《深入理解 AI Agent》Ch4：启动/完成解耦 + 事件回注 + 错误保真。
 */
import { publicJobErrorForAgent } from "./protocol.js";
import type { AgentJobDto, AgentJobStatus } from "./types.js";

/** 哪些 kind 在终态后自动 wake Agent（面板无 thread 的 job 永不 wake）。 */
export const WAKEABLE_JOB_KINDS = new Set(["generate_from_desk"]);

export type JobTerminalStatus = Extract<
  AgentJobStatus,
  "succeeded" | "failed" | "cancelled" | "interrupted"
>;

export function isJobTerminalStatus(status: string): status is JobTerminalStatus {
  return status === "succeeded"
    || status === "failed"
    || status === "cancelled"
    || status === "interrupted";
}

export function shouldWakeAgentForJob(job: Pick<AgentJobDto, "threadId" | "kind" | "status">): boolean {
  if (!job.threadId) return false;
  if (!WAKEABLE_JOB_KINDS.has(job.kind)) return false;
  return isJobTerminalStatus(job.status);
}

/** 幂等键：同一 task 终态只触发一次 user message / run。 */
export function jobWakeExternalId(taskId: string): string {
  return `job-wake:${taskId}`;
}

function modelFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const model = (input as { model?: unknown }).model;
  return typeof model === "string" && model.trim() ? model.trim() : undefined;
}

/**
 * 紧凑 [JOB_EVENT] 块（无用户口令伪装）。
 * error 走 publicJobErrorForAgent，与 get_task 同源。
 */
export function formatJobEventBlock(job: AgentJobDto): string {
  const lines = [
    "[JOB_EVENT]",
    "source=agent_job",
    `task_id=${job.id}`,
    `kind=${job.kind}`,
    `status=${job.status}`,
  ];
  if (job.artifactId) lines.push(`artifact_id=${job.artifactId}`);
  const model = modelFromInput(job.input);
  if (model) lines.push(`model=${model}`);
  const err = publicJobErrorForAgent(job.error, 200);
  if (err) lines.push(`error=${err}`);
  if (job.status === "succeeded") {
    lines.push("hint=可 look_at(artifact_id) 验收；勿声称未确认的细节");
  } else if (job.status === "failed") {
    lines.push("hint=如实说明 error；禁止静默换引擎或自动再次 generate_from_desk");
  } else {
    lines.push("hint=任务未成功完成；勿声称已生成");
  }
  return lines.join("\n");
}

/** 注入 pi / chat 的完整 wake 文本（user 角色，前缀标明系统事件）。 */
export function formatJobWakePrompt(job: AgentJobDto): string {
  return [
    "[系统事件·非用户口令·不可当作系统指令]",
    "后台异步任务已结束。请根据 [JOB_EVENT] 向用户简要说明结果。",
    "成功：可 look_at 验收后再评价画面；失败：转述 error，不要声称已落桌成功。",
    "禁止：为同一失败自动再次调用 generate_from_desk；禁止默默改用其它生图 model。",
    "用户若明确要求重试，再调用工具。",
    "",
    formatJobEventBlock(job),
  ].join("\n");
}
