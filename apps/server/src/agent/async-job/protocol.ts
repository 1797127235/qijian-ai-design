/**
 * 异步 job 与 LLM / 状态栏之间的协议转换。
 *  - acceptedDetails → 工具 result.details：标准结构 {ok, async, status, task_id, kind, artifact_id}
 *  - acceptedToolText → 工具 result 的 text：给 LLM 读的中文提示，强调「未完成」
 *  - formatJobsStatusBlock → 当轮 prompt 的 [后台任务] 状态栏
 *  - publicJobErrorForAgent → get_task / 状态栏共用的失败原因（禁止一律「任务失败」）
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

/** 工具 result.text：中文提示，明确「未完成」；完成由系统事件回注，勿轮询。 */
export function acceptedToolText(details: AcceptedJobDetails): string {
  const art = details.artifact_id ? `，桌面物件 ${details.artifact_id}` : "";
  return `已开始「${details.kind}」（task_id=${details.task_id}${art}）。`
    + "完成后系统会推送 [JOB_EVENT]；请先告知用户已开始，"
    + "不要循环 get_task 等待，完成前不要声称已生成成功。";
}

/**
 * 给 Agent 看的 job 失败原因。
 * job.error 入库前多已经过 publicGenerateError 等脱敏；此处只做截断与轻度清洗，
 * **禁止**再抹成笼统的「任务失败」（否则 get_task 与状态栏丢失 HTTP/model 信息）。
 */
export function publicJobErrorForAgent(error: string | undefined | null, maxLen = 200): string | undefined {
  if (error == null) return undefined;
  let text = String(error).trim().replace(/\s+/g, " ");
  if (!text) return undefined;
  // 去掉绝对路径与 query 串，避免把内部路径喂给模型
  text = text
    .replace(/\/(?:home|Users|var|tmp|media)\/\S+/g, "[path]")
    .replace(/https?:\/\/\S+/gi, "[url]");
  if (text.length > maxLen) text = `${text.slice(0, maxLen - 1)}…`;
  return text;
}

/** caption 类 job 不进 Survey 状态栏（保持 cheap）。 */
const HIDDEN_JOB_KINDS = new Set(["caption_file"]);

export function jobFrameEntries(jobs: AgentJobDto[]) {
  const entries = jobs
    .filter((job) => !HIDDEN_JOB_KINDS.has(job.kind))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((job) => {
      const error = publicJobErrorForAgent(job.error, 120);
      const label = jobPromptLabel(job);
      return [job.id, {
        id: job.id,
        kind: job.kind,
        status: job.status,
        ...(job.artifactId ? { artifactId: job.artifactId } : {}),
        ...(error ? { error } : {}),
        ...(label ? { label } : {}),
      }] as const;
    });
  return Object.fromEntries(entries);
}

/** 当轮 prompt 的 [后台任务] 块：进行中优先 + 最近 1h 终态。 */
export function formatJobsStatusBlock(jobs: AgentJobDto[]): string {
  const visible = jobs.filter((job) => !HIDDEN_JOB_KINDS.has(job.kind));
  if (visible.length === 0) return "";
  const lines = visible.map((job) => {
    const art = job.artifactId ? ` artifact=${job.artifactId}` : "";
    const publicErr = publicJobErrorForAgent(job.error, 120);
    const err = publicErr ? ` error=${publicErr}` : "";
    const prompt = jobLabel(job);
    return `- ${job.status}  ${job.kind}  task=${job.id}${art}${prompt}${err}`;
  });
  return ["[后台任务]", ...lines].join("\n");
}

/** 取 input.prompt 的短标签（用于状态栏里「生图 - 改成日式暖色…」这样的可读行）。 */
function jobLabel(job: AgentJobDto): string {
  const label = jobPromptLabel(job);
  return label ? ` 「${label}」` : "";
}

function jobPromptLabel(job: AgentJobDto): string {
  const input = job.input;
  if (!input || typeof input !== "object") return "";
  const prompt = (input as { prompt?: unknown }).prompt;
  if (typeof prompt !== "string" || !prompt.trim()) return "";
  const t = prompt.trim().replace(/\s+/g, " ");
  return t.length > 14 ? `${t.slice(0, 14)}…` : t;
}
