/**
 * 模型 usage / prompt cache 采集（L1 日志 + L2 观测）。
 * 数据源：pi assistant message.usage（message_end）。
 * hit_rate 公式版本固定，便于对照网关语义差异。
 */

export const CACHE_HIT_FORMULA = "cacheRead/(input+cacheRead)" as const;

export type TokenUsageSample = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  /** 衍生；分母为 0 时为 null */
  hitRate: number | null;
  formula: typeof CACHE_HIT_FORMULA;
};

export type TokenUsageAggregate = {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  hitRate: number | null;
  formula: typeof CACHE_HIT_FORMULA;
  /** 任一轮 cacheRead 或 cacheWrite > 0 */
  cacheSignal: boolean;
};

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function hitRate(input: number, cacheRead: number): number | null {
  const denom = input + cacheRead;
  if (denom <= 0) return null;
  return cacheRead / denom;
}

export function sampleFromUsage(usage: unknown): TokenUsageSample | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  // 至少有一个计量字段才算有效（避免空对象）
  if (!("input" in u) && !("cacheRead" in u) && !("output" in u) && !("totalTokens" in u)) {
    return null;
  }
  const input = num(u.input);
  const output = num(u.output);
  const cacheRead = num(u.cacheRead);
  const cacheWrite = num(u.cacheWrite);
  const totalTokens = num(u.totalTokens) || input + output;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    hitRate: hitRate(input, cacheRead),
    formula: CACHE_HIT_FORMULA,
  };
}

/** 从 pi message_end 事件抠 assistant.usage */
export function sampleFromMessageEndEvent(event: unknown): TokenUsageSample | null {
  if (!event || typeof event !== "object") return null;
  if ((event as { type?: unknown }).type !== "message_end") return null;
  const message = (event as { message?: unknown }).message;
  if (!message || typeof message !== "object") return null;
  if ((message as { role?: unknown }).role !== "assistant") return null;
  return sampleFromUsage((message as { usage?: unknown }).usage);
}

export function emptyUsageAggregate(): TokenUsageAggregate {
  return {
    turns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    hitRate: null,
    formula: CACHE_HIT_FORMULA,
    cacheSignal: false,
  };
}

export function addUsageSample(
  agg: TokenUsageAggregate,
  sample: TokenUsageSample,
): TokenUsageAggregate {
  const input = agg.input + sample.input;
  const output = agg.output + sample.output;
  const cacheRead = agg.cacheRead + sample.cacheRead;
  const cacheWrite = agg.cacheWrite + sample.cacheWrite;
  const totalTokens = agg.totalTokens + sample.totalTokens;
  return {
    turns: agg.turns + 1,
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    hitRate: hitRate(input, cacheRead),
    formula: CACHE_HIT_FORMULA,
    cacheSignal: agg.cacheSignal || sample.cacheRead > 0 || sample.cacheWrite > 0,
  };
}

export function isUsageLogEnabled(): boolean {
  const v = process.env.AGENT_LOG_USAGE?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** L1：一行 JSON，便于 grep / 采集。 */
export function formatUsageLogLine(fields: {
  projectId: string;
  threadId: string;
  runId?: string;
  model?: string;
  sample: TokenUsageSample;
  aggregate?: TokenUsageAggregate;
}): string {
  return JSON.stringify({
    type: "model_usage",
    project_id: fields.projectId,
    thread_id: fields.threadId,
    run_id: fields.runId,
    model: fields.model,
    turn: fields.sample,
    run_agg: fields.aggregate,
  });
}
