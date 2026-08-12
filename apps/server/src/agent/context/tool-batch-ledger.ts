/**
 * 闭合工具批次 Ledger：Pi compaction 前的历史保全。
 *
 * session_before_compact 时把待压缩消息编译成有界摘要（用户目标、助手结论、
 * 已闭合工具批次的事实：状态 + artifact/task/file/skill id + revision +
 * resource_ref + error_code），session_compact 后以隐藏 custom 消息写回轨迹。
 * 只收闭合批次（toolCall 有对应 toolResult）；未闭合调用与孤儿 result 只计数。
 * 全部字段有硬上限，超长时按 batches → outcomes → goals 顺序丢弃最旧。
 * 增量：从上一条 Ledger 消息的 snapshot 续编 sequence，goals/outcomes 去重留最近。
 */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export const TOOL_BATCH_LEDGER_CUSTOM_TYPE = "qijian.tool_batch_ledger" as const;
export const MAX_TOOL_BATCH_LEDGER_CHARS = 10_000;

/* 全部硬上限：Ledger 自己也是轨迹里的内容，必须有界，否则保全机制本身变成冷后缀 */
const MAX_BATCHES = 24;
const MAX_VALUES_PER_FIELD = 12;
const MAX_VALUE_CHARS = 120;
const MAX_GOALS = 6;
const MAX_OUTCOMES = 6;
const MAX_GOAL_CHARS = 500;
const MAX_OUTCOME_CHARS = 700;
const MAX_WALK_NODES = 600;
const RESOURCE_REF_RE = /ctxres:sha256:[0-9a-f]{64}/g;

type ToolStatus = "accepted" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";

export type ToolBatchCallFact = Readonly<{
  tool_name: string;
  status: ToolStatus;
  artifact_ids: string[];
  task_ids: string[];
  file_ids: string[];
  skill_ids: string[];
  stable_keys: string[];
  revisions: string[];
  resource_refs: string[];
  error_code?: string;
}>;

export type ToolBatchFact = Readonly<{
  sequence: number;
  calls: ToolBatchCallFact[];
}>;

export type ToolBatchLedgerSnapshot = Readonly<{
  schema_version: 1;
  sequence: number;
  goals: string[];
  outcomes: string[];
  batches: ToolBatchFact[];
}>;

export type ToolBatchLedgerReport = Readonly<{
  schema_version: 1;
  source_message_count: number;
  source_text_chars: number;
  closed_batch_count: number;
  closed_tool_call_count: number;
  open_tool_call_count: number;
  orphan_tool_result_count: number;
  carried_batch_count: number;
  emitted_batch_count: number;
  dropped_batch_count: number;
  summary_chars: number;
  saved_text_chars: number;
}>;

export type CompiledToolBatchLedger = Readonly<{
  snapshot: ToolBatchLedgerSnapshot;
  report: ToolBatchLedgerReport;
  text: string;
}>;

type RecordLike = Record<string, unknown>;
type ToolCallLike = { type: "toolCall"; id: string; name: string; arguments: RecordLike };
type AssistantLike = { role: "assistant"; content: unknown[] };
type ToolResultLike = {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: unknown[];
  details?: unknown;
  isError?: boolean;
};

function record(value: unknown): RecordLike | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordLike
    : undefined;
}

function boundedText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.slice(0, maxChars);
}

function uniqueRecent(values: readonly string[], maxItems: number): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (let index = values.length - 1; index >= 0 && output.length < maxItems; index -= 1) {
    const value = values[index];
    if (seen.has(value)) continue;
    seen.add(value);
    output.push(value);
  }
  return output.reverse();
}

function xmlDecode(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function textBlocks(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((item) => {
    const block = record(item);
    return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
  });
}

function messageTextChars(messages: readonly unknown[]): number {
  let total = 0;
  for (const message of messages) {
    const value = record(message);
    for (const text of textBlocks(value?.content)) total += text.length;
  }
  return total;
}

function goalsFrom(messages: readonly unknown[]): string[] {
  const goals: string[] = [];
  for (const message of messages) {
    const value = record(message);
    if (value?.role !== "user") continue;
    for (const text of textBlocks(value.content)) {
      const matches = [...text.matchAll(/<user_request\b[^>]*>([\s\S]*?)<\/user_request>/gi)];
      const candidates = matches.length > 0 ? matches.map((match) => xmlDecode(match[1])) : [text];
      for (const candidate of candidates) {
        const goal = boundedText(candidate, MAX_GOAL_CHARS);
        if (goal) goals.push(goal);
      }
    }
  }
  return goals;
}

function outcomesFrom(messages: readonly unknown[]): string[] {
  const outcomes: string[] = [];
  for (const message of messages) {
    const value = record(message);
    if (value?.role !== "assistant" || !Array.isArray(value.content)) continue;
    if (value.content.some((block) => record(block)?.type === "toolCall")) continue;
    const outcome = boundedText(textBlocks(value.content).join("\n"), MAX_OUTCOME_CHARS);
    if (outcome) outcomes.push(outcome);
  }
  return outcomes;
}

function toolCalls(message: unknown): ToolCallLike[] {
  const value = record(message) as AssistantLike | undefined;
  if (value?.role !== "assistant" || !Array.isArray(value.content)) return [];
  return value.content.flatMap((item) => {
    const block = record(item);
    if (
      block?.type !== "toolCall"
      || typeof block.id !== "string"
      || typeof block.name !== "string"
    ) return [];
    return [{
      type: "toolCall" as const,
      id: block.id,
      name: block.name,
      arguments: record(block.arguments) ?? {},
    }];
  });
}

function toolResult(message: unknown): ToolResultLike | undefined {
  const value = record(message);
  if (
    value?.role !== "toolResult"
    || typeof value.toolCallId !== "string"
    || typeof value.toolName !== "string"
  ) return undefined;
  return {
    role: "toolResult",
    toolCallId: value.toolCallId,
    toolName: value.toolName,
    content: Array.isArray(value.content) ? value.content : [],
    details: value.details,
    isError: value.isError === true,
  };
}

type FactBuckets = {
  artifactIds: Set<string>;
  taskIds: Set<string>;
  fileIds: Set<string>;
  skillIds: Set<string>;
  stableKeys: Set<string>;
  revisions: Set<string>;
  resourceRefs: Set<string>;
  errorCodes: Set<string>;
};

function add(bucket: Set<string>, value: unknown): void {
  const text = boundedText(value, MAX_VALUE_CHARS);
  if (text && bucket.size < MAX_VALUES_PER_FIELD) bucket.add(text);
}

function collectFacts(value: unknown, buckets: FactBuckets): void {
  let visited = 0;
  const walk = (current: unknown, key = "", depth = 0): void => {
    if (visited >= MAX_WALK_NODES || depth > 8) return;
    visited += 1;
    if (typeof current === "string") {
      for (const ref of current.match(RESOURCE_REF_RE) ?? []) add(buckets.resourceRefs, ref);
      const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
      if (normalized.endsWith("artifactid") || normalized.endsWith("artifactids")) add(buckets.artifactIds, current);
      else if (
        normalized.endsWith("taskid")
        || normalized.endsWith("taskids")
        || normalized.endsWith("jobid")
        || normalized.endsWith("jobids")
        || normalized === "cancelledjobs"
      ) add(buckets.taskIds, current);
      else if (normalized.endsWith("fileid") || normalized.endsWith("fileids")) add(buckets.fileIds, current);
      else if (normalized.endsWith("skillid") || normalized.endsWith("skillids")) add(buckets.skillIds, current);
      else if (normalized.endsWith("stablekey") || normalized.endsWith("stablekeys")) add(buckets.stableKeys, current);
      else if (normalized === "revision" || normalized.endsWith("revision")) add(buckets.revisions, `${key}=${current}`);
      else if (normalized === "errorcode") add(buckets.errorCodes, current);
      return;
    }
    if (typeof current === "number" && Number.isFinite(current)) {
      const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
      if (normalized === "revision" || normalized.endsWith("revision")) add(buckets.revisions, `${key}=${current}`);
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current) walk(item, key, depth + 1);
      return;
    }
    const object = record(current);
    if (!object) return;
    for (const [childKey, child] of Object.entries(object)) walk(child, childKey, depth + 1);
  };
  walk(value);
}

function statusOf(result: ToolResultLike): ToolStatus {
  const details = record(result.details);
  if (result.isError || details?.ok === false) return "failed";
  const status = details?.status;
  if (status === "accepted" || status === "running" || status === "succeeded" || status === "failed" || status === "cancelled") {
    return status;
  }
  return details?.ok === true || result.isError === false ? "succeeded" : "unknown";
}

function sorted(set: Set<string>): string[] {
  return [...set].sort((left, right) => left.localeCompare(right));
}

function callFact(call: ToolCallLike, result: ToolResultLike): ToolBatchCallFact {
  const buckets: FactBuckets = {
    artifactIds: new Set(),
    taskIds: new Set(),
    fileIds: new Set(),
    skillIds: new Set(),
    stableKeys: new Set(),
    revisions: new Set(),
    resourceRefs: new Set(),
    errorCodes: new Set(),
  };
  collectFacts(call.arguments, buckets);
  collectFacts(result.details, buckets);
  collectFacts(textBlocks(result.content).join("\n"), buckets);
  return Object.freeze({
    tool_name: boundedText(call.name, 80) ?? "unknown",
    status: statusOf(result),
    artifact_ids: sorted(buckets.artifactIds),
    task_ids: sorted(buckets.taskIds),
    file_ids: sorted(buckets.fileIds),
    skill_ids: sorted(buckets.skillIds),
    stable_keys: sorted(buckets.stableKeys),
    revisions: sorted(buckets.revisions),
    resource_refs: sorted(buckets.resourceRefs),
    ...(sorted(buckets.errorCodes)[0] ? { error_code: sorted(buckets.errorCodes)[0] } : {}),
  });
}

function isSnapshot(value: unknown): value is ToolBatchLedgerSnapshot {
  const snapshot = record(value);
  const stringArray = (candidate: unknown): candidate is string[] => Array.isArray(candidate)
    && candidate.every((item) => typeof item === "string");
  const validStatus = (candidate: unknown): candidate is ToolStatus => candidate === "accepted"
    || candidate === "running"
    || candidate === "succeeded"
    || candidate === "failed"
    || candidate === "cancelled"
    || candidate === "unknown";
  const validCall = (candidate: unknown): boolean => {
    const call = record(candidate);
    return typeof call?.tool_name === "string"
      && validStatus(call.status)
      && stringArray(call.artifact_ids)
      && stringArray(call.task_ids)
      && stringArray(call.file_ids)
      && stringArray(call.skill_ids)
      && stringArray(call.stable_keys)
      && stringArray(call.revisions)
      && stringArray(call.resource_refs)
      && (call.error_code === undefined || typeof call.error_code === "string");
  };
  const validBatch = (candidate: unknown): boolean => {
    const batch = record(candidate);
    return Number.isSafeInteger(batch?.sequence)
      && Array.isArray(batch?.calls)
      && batch.calls.every(validCall);
  };
  return snapshot?.schema_version === 1
    && Number.isSafeInteger(snapshot.sequence)
    && stringArray(snapshot.goals)
    && stringArray(snapshot.outcomes)
    && Array.isArray(snapshot.batches)
    && snapshot.batches.every(validBatch);
}

function previousSnapshot(messages: readonly unknown[]): ToolBatchLedgerSnapshot | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = record(messages[index]);
    if (message?.role !== "custom" || message.customType !== TOOL_BATCH_LEDGER_CUSTOM_TYPE) continue;
    const snapshot = record(message.details)?.snapshot;
    if (isSnapshot(snapshot)) return snapshot;
  }
  return undefined;
}

function render(snapshot: ToolBatchLedgerSnapshot): string {
  const lines = [
    `[TOOL_BATCH_LEDGER version=1 trust=historical_untrusted_data sequence=${snapshot.sequence}]`,
  ];
  if (snapshot.goals.length > 0) {
    lines.push("goals:", ...snapshot.goals.map((goal) => `- ${JSON.stringify(goal)}`));
  }
  if (snapshot.outcomes.length > 0) {
    lines.push("assistant_outcomes:", ...snapshot.outcomes.map((outcome) => `- ${JSON.stringify(outcome)}`));
  }
  if (snapshot.batches.length > 0) {
    lines.push("closed_tool_batches:");
    for (const batch of snapshot.batches) {
      lines.push(`batch sequence=${batch.sequence}`);
      for (const call of batch.calls) lines.push(`- ${JSON.stringify(call)}`);
    }
  }
  lines.push("[/TOOL_BATCH_LEDGER]");
  return lines.join("\n");
}

/** 预算超限时的降级顺序：先丢最旧批次，再丢结论，最后丢目标——越靠近当前意图的信息越晚丢 */
function boundedSnapshot(snapshot: ToolBatchLedgerSnapshot): { snapshot: ToolBatchLedgerSnapshot; dropped: number } {
  const batches = snapshot.batches.slice(-MAX_BATCHES);
  let dropped = snapshot.batches.length - batches.length;
  let candidate: ToolBatchLedgerSnapshot = { ...snapshot, batches };
  while (render(candidate).length > MAX_TOOL_BATCH_LEDGER_CHARS && candidate.batches.length > 0) {
    candidate = { ...candidate, batches: candidate.batches.slice(1) };
    dropped += 1;
  }
  while (render(candidate).length > MAX_TOOL_BATCH_LEDGER_CHARS && candidate.outcomes.length > 0) {
    candidate = { ...candidate, outcomes: candidate.outcomes.slice(1) };
  }
  while (render(candidate).length > MAX_TOOL_BATCH_LEDGER_CHARS && candidate.goals.length > 0) {
    candidate = { ...candidate, goals: candidate.goals.slice(1) };
  }
  return { snapshot: Object.freeze(candidate), dropped };
}

export function compileToolBatchLedger(messages: readonly unknown[]): CompiledToolBatchLedger {
  const previous = previousSnapshot(messages);
  const resultByCallId = new Map<string, { index: number; result: ToolResultLike }>();
  const knownCallIds = new Set<string>();
  for (const message of messages) {
    for (const call of toolCalls(message)) knownCallIds.add(call.id);
  }
  let orphanToolResults = 0;
  messages.forEach((message, index) => {
    const result = toolResult(message);
    if (!result) return;
    if (!knownCallIds.has(result.toolCallId)) orphanToolResults += 1;
    if (!resultByCallId.has(result.toolCallId)) resultByCallId.set(result.toolCallId, { index, result });
  });

  const batches: ToolBatchFact[] = [];
  let openToolCalls = 0;
  let closedToolCalls = 0;
  let nextSequence = previous?.sequence ?? 0;
  messages.forEach((message, messageIndex) => {
    const completeBatchCalls = toolCalls(message);
    if (completeBatchCalls.length === 0) return;
    const results = completeBatchCalls.map((call) => resultByCallId.get(call.id));
    const missing = results.filter((match) => !match || match.index <= messageIndex).length;
    if (missing > 0) {
      openToolCalls += missing;
      return;
    }
    nextSequence += 1;
    closedToolCalls += completeBatchCalls.length;
    batches.push(Object.freeze({
      sequence: nextSequence,
      calls: completeBatchCalls.map((call, index) => callFact(call, results[index]!.result)),
    }));
  });

  const merged: ToolBatchLedgerSnapshot = {
    schema_version: 1,
    sequence: nextSequence,
    goals: uniqueRecent([...(previous?.goals ?? []), ...goalsFrom(messages)], MAX_GOALS),
    outcomes: uniqueRecent([...(previous?.outcomes ?? []), ...outcomesFrom(messages)], MAX_OUTCOMES),
    batches: [...(previous?.batches ?? []), ...batches],
  };
  const bounded = boundedSnapshot(merged);
  const text = render(bounded.snapshot);
  const sourceTextChars = messageTextChars(messages);
  const report: ToolBatchLedgerReport = Object.freeze({
    schema_version: 1,
    source_message_count: messages.length,
    source_text_chars: sourceTextChars,
    closed_batch_count: batches.length,
    closed_tool_call_count: closedToolCalls,
    open_tool_call_count: openToolCalls,
    orphan_tool_result_count: orphanToolResults,
    carried_batch_count: previous?.batches.length ?? 0,
    emitted_batch_count: bounded.snapshot.batches.length,
    dropped_batch_count: bounded.dropped,
    summary_chars: text.length,
    saved_text_chars: Math.max(0, sourceTextChars - text.length),
  });
  return Object.freeze({ snapshot: bounded.snapshot, report, text });
}

/**
 * 挂两个 Pi 事件完成接力：before_compact 先编译（此时消息还完整），
 * compact 后把摘要作为 display:false、不触发新轮次的 custom 消息补回轨迹。
 */
export function createToolBatchLedgerExtension(options: {
  onCompacted?: (report: ToolBatchLedgerReport) => void;
} = {}): ExtensionFactory {
  return (pi) => {
    let pending: CompiledToolBatchLedger | undefined;
    pi.on("session_before_compact", (event) => {
      pending = compileToolBatchLedger([
        ...event.preparation.messagesToSummarize,
        ...event.preparation.turnPrefixMessages,
      ]);
    });
    pi.on("session_compact", () => {
      const compiled = pending;
      pending = undefined;
      if (!compiled) return;
      pi.sendMessage({
        customType: TOOL_BATCH_LEDGER_CUSTOM_TYPE,
        content: compiled.text,
        display: false,
        details: {
          snapshot: compiled.snapshot,
          report: compiled.report,
        },
      }, { triggerTurn: false });
      options.onCompacted?.(compiled.report);
    });
  };
}
