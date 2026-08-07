/**
 * 异步 job 与 LLM / 状态栏之间的协议转换。
 *  - acceptedDetails → 工具 result.details：标准结构 {ok, async, status, task_id, kind, artifact_id}
 *  - acceptedToolText → 工具 result 的 text：给 LLM 读的中文提示，强调「未完成」
 *  - formatJobsStatusBlock → 当轮 prompt 的 [后台任务] 状态栏
 */
import type { AgentJobDto, AcceptedJobDetails } from "./types.js";

/** 工具 result.details 结构：LLM 与前端都用 task_id 续接状态。 */
export function acceptedDetails(job: AgentJobDto, artifactId?: string): AcceptedJobDetails {
  return {
    ok: true,
    async: true,
    status: "accepted",
    task_id: job.id,
    kind: job.kind,
    ...(artifactId || job.artifactId
      ? { artifact_id: artifactId ?? job.artifactId }
      : {}),
  };
}

/** 工具 result.text：中文提示，明确「未完成」。 */
export function acceptedToolText(details: AcceptedJobDetails): string {
  const art = details.artifact_id ? `，桌面物件 ${details.artifact_id}` : "";
  return `已开始「${details.kind}」（task_id=${details.task_id}${art}）。进度见桌面与后台任务状态；完成前不要声称已生成成功。`;
}

/** 当轮 prompt 的 [后台任务] 块：进行中优先 + 最近 1h 终态。 */
export function formatJobsStatusBlock(jobs: AgentJobDto[]): string {
  if (jobs.length === 0) return "";
  const lines = jobs.map((job) => {
    const art = job.artifactId ? ` artifact=${job.artifactId}` : "";
    const err = job.error ? ` error=${job.error.slice(0, 40)}` : "";
    const prompt = jobLabel(job);
    return `- ${job.status}  ${job.kind}  task=${job.id}${art}${prompt}${err}`;
  });
  return ["[后台任务]", ...lines].join("\n");
}

/** 取 input.prompt 的短标签（用于状态栏里「生图 - 改成日式暖色…」这样的可读行）。 */
function jobLabel(job: AgentJobDto): string {
  const input = job.input;
  if (!input || typeof input !== "object") return "";
  const prompt = (input as { prompt?: unknown }).prompt;
  if (typeof prompt !== "string" || !prompt.trim()) return "";
  const t = prompt.trim().replace(/\s+/g, " ");
  const short = t.length > 14 ? `${t.slice(0, 14)}…` : t;
  return ` 「${short}」`;
}
