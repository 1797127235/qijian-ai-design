import type { ProcessSnapshot, ProcessStep } from "../types";

type ToolStep = Extract<ProcessStep, { kind: "tool" }>;

export function toolSteps(process: ProcessSnapshot): ToolStep[] {
  return process.steps.filter((s): s is ToolStep => s.kind === "tool");
}

function hasThinking(process: ProcessSnapshot): boolean {
  return process.steps.some((s) => s.kind === "thinking" && s.text.trim());
}

const TOOL_LABELS: Record<string, string> = {
  generate_from_desk: "桌面生图",
};

export function toolLabel(name: string) {
  return TOOL_LABELS[name] ?? name;
}

function elapsedSeconds(process: ProcessSnapshot) {
  const start = Number(process.startedAt);
  const end = Number(process.endedAt ?? Date.now());
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 1;
  return Math.max(1, Math.round((end - start) / 1000));
}

/** 折叠行标题：秒数由 startedAt/endedAt 动态计算 */
export function processTitle(process: ProcessSnapshot): string {
  const sec = elapsedSeconds(process);
  const tools = toolSteps(process);
  if (process.status === "running") {
    const running = tools.find((t) => t.status === "running");
    if (running) return `${toolLabel(running.name)}中`;
    // 工具已结束但整轮未 settled：仍算进行中，不要写成「思考了」
    if (tools.some((t) => t.status === "failed")) return `处理中 · ${sec}s`;
    if (hasThinking(process)) return `思考中 · ${sec}s`;
    return `处理中 · ${sec}s`;
  }
  // 结束后统一「思考了 Ns」（对齐参考）；失败不在标题里堆工具名
  if (hasThinking(process) || tools.length > 0) return `思考了 ${sec}s`;
  return `用了 ${sec}s`;
}

/** 工具行：已调用桌面生图 / 桌面生图失败 */
export function toolLine(step: ToolStep): string {
  const name = toolLabel(step.name);
  if (step.status === "running") return `${name}中…`;
  if (step.status === "failed") return step.label ? `${name}失败：${step.label}` : `${name}失败`;
  return `已调用${name}`;
}

function contentText(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .flatMap((item) => (
      item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
        ? [(item as { text: string }).text]
        : []
    ))
    .join("\n")
    .trim();
  return text || undefined;
}

export function isToolBusinessFailure(result: unknown, isError?: boolean): boolean {
  if (isError) return true;
  if (!result || typeof result !== "object") return false;
  const details = (result as { details?: unknown }).details;
  if (details && typeof details === "object") {
    const d = details as Record<string, unknown>;
    if (d.ok === false || d.status === "failed") return true;
  }
  const text = contentText(result);
  return Boolean(text && /失败|错误|未找到|不能|无法/.test(text));
}

export function toolStepLabel(args: unknown, result: unknown, failed: boolean): string | undefined {
  if (failed) {
    if (result && typeof result === "object") {
      const details = (result as { details?: Record<string, unknown> }).details;
      if (typeof details?.error === "string" && details.error.trim()) {
        return details.error.trim().slice(0, 80);
      }
    }
    const text = contentText(result);
    if (text) return text.split(/[。\n]/)[0]?.slice(0, 80);
    return undefined;
  }
  if (args && typeof args === "object") {
    const prompt = (args as { prompt?: unknown }).prompt;
    if (typeof prompt === "string" && prompt.trim()) {
      const t = prompt.trim().replace(/\s+/g, " ");
      return t.length > 48 ? `${t.slice(0, 48)}…` : t;
    }
  }
  return undefined;
}

export function emptyProcess(startedAt = Date.now()): ProcessSnapshot {
  return { status: "running", startedAt, steps: [] };
}
