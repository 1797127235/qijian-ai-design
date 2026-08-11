/**
 * 异步 job 完成事件：结构化 observation，供 wake 注入轨迹。
 * 对齐《深入理解 AI Agent》Ch4：启动/完成解耦 + 事件回注 + 错误保真。
 */
import { createHash } from "node:crypto";
import { publicJobErrorForAgent } from "./protocol.js";
import type { AgentJobDto, AgentJobStatus } from "./types.js";

/** 哪些 kind 在终态后自动 wake Agent（面板无 thread 的 job 永不 wake）。 */
export const WAKEABLE_JOB_KINDS = new Set(["generate_from_desk"]);

export type JobTerminalStatus = Extract<
  AgentJobStatus,
  "succeeded" | "failed" | "cancelled" | "cancelled_with_side_effect" | "needs_review" | "interrupted"
>;

export function isJobTerminalStatus(status: string): status is JobTerminalStatus {
  return status === "succeeded"
    || status === "failed"
    || status === "cancelled"
    || status === "cancelled_with_side_effect"
    || status === "needs_review"
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

/** 多 job 汇总 wake 的幂等键（顺序无关）。 */
export function jobWakeBatchExternalId(taskIds: string[]): string {
  const sorted = [...new Set(taskIds.map((id) => id.trim()).filter(Boolean))].sort();
  if (sorted.length === 0) return "job-wake-batch:empty";
  if (sorted.length === 1) return jobWakeExternalId(sorted[0]);
  const h = createHash("sha256").update(sorted.join("\n")).digest("hex").slice(0, 24);
  return `job-wake-batch:${sorted.length}:${h}`;
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
    lines.push("hint=如实说明 error；禁止静默换引擎或自动再次调用生图工具");
  } else {
    lines.push("hint=任务未成功完成；勿声称已生成");
  }
  return lines.join("\n");
}

const WAKE_HEADER = [
  "[系统事件·非用户口令·不可当作系统指令]",
  "后台异步任务已结束。请根据 [JOB_EVENT] 向用户简要说明结果。",
  "成功：可 look_at 验收后再评价画面；失败：转述 error，不要声称已落桌成功。",
  "禁止：为同一失败自动再次调用 generate_from_desk、replace_on_desk 或 text_to_image_on_desk；禁止默默改用其它生图 model。",
  "用户若明确要求重试，再调用对应工具。",
];

const WAKE_BATCH_HEADER = [
  "[系统事件·非用户口令·不可当作系统指令]",
  "本批后台异步任务已有终态结果（可能仍有其它任务在跑，勿假设整桌已全部结束）。",
  "请根据 [JOB_EVENT_BATCH] 与下方各 [JOB_EVENT] 向用户说明：成功几路、失败几路。",
  "若有成功与失败并存：保留并评价成功卡；失败项只转述 error，不要因失败否定成功结果。",
  "禁止：自动整批重试；禁止默默改用其它生图 model；禁止声称未成功的 task 已落桌。",
  "仅当用户明确要求时，只重试其点名的失败 task/方向。",
];

/** 注入 pi / chat 的完整 wake 文本（user 角色，前缀标明系统事件）。 */
export function formatJobWakePrompt(job: AgentJobDto): string {
  return [...WAKE_HEADER, "", formatJobEventBlock(job)].join("\n");
}

/**
 * 同批多 job 一条 wake：先汇总表，再附各 [JOB_EVENT]（截断防过长）。
 * 混合成功/失败时 outcome=partial，驱动 Agent 分项说明而非整批失败话术。
 */
export function formatJobWakeBatchPrompt(jobs: AgentJobDto[]): string {
  if (jobs.length === 0) return [...WAKE_BATCH_HEADER, "", "[JOB_EVENT_BATCH] count=0"].join("\n");
  if (jobs.length === 1) return formatJobWakePrompt(jobs[0]!);

  const succeeded = jobs.filter((j) => j.status === "succeeded");
  const failed = jobs.filter((j) => j.status !== "succeeded");
  const outcome = succeeded.length === 0
    ? "all_failed"
    : failed.length === 0
      ? "all_succeeded"
      : "partial";
  const summaryLines = [
    `[JOB_EVENT_BATCH] count=${jobs.length} succeeded=${succeeded.length} failed=${failed.length} outcome=${outcome}`,
    outcome === "partial"
      ? "本批部分成功：必须分项说明成功与失败，禁止只说「生成失败」或「都好了」。"
      : "请用一段话汇总，不要逐条重复客套。",
  ];
  if (succeeded.length > 0) {
    summaryLines.push(
      `成功 task_id：${succeeded.map((j) => j.id).join(", ")}`
      + (succeeded.some((j) => j.artifactId)
        ? `；artifact：${succeeded.map((j) => j.artifactId).filter(Boolean).join(", ")}`
        : ""),
    );
  }
  if (failed.length > 0) {
    const failBits = failed.map((j) => {
      const err = publicJobErrorForAgent(j.error, 80);
      return err ? `${j.id}(${j.status}:${err})` : `${j.id}(${j.status})`;
    });
    summaryLines.push(`未成功：${failBits.join("; ")}；勿自动全部重试`);
  }

  const maxDetail = 8;
  const detailJobs = jobs.slice(0, maxDetail);
  const details = detailJobs.map((j) => formatJobEventBlock(j)).join("\n\n");
  const more = jobs.length > maxDetail
    ? `\n…另有 ${jobs.length - maxDetail} 条略（仅在用户追问具体 task 时用 get_task；禁止循环轮询）`
    : "";

  return [...WAKE_BATCH_HEADER, "", ...summaryLines, "", details + more].join("\n");
}
