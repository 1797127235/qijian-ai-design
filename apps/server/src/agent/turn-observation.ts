import type { TraceHandle } from "./tracing/types.js";
import type { TokenUsageSample } from "./usage-metrics.js";

export type PayloadSummary = Readonly<{
  kind: "null" | "array" | "object" | "string" | "number" | "boolean" | "other";
  characters: number;
  bytes: number;
  keys?: string[];
  keyCount?: number;
  itemCount?: number;
  serializationError?: boolean;
}>;

function payloadKind(value: unknown): PayloadSummary["kind"] {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "other";
}

/** Size/shape only: no argument or result values leave this boundary. */
export function summarizePayload(value: unknown): PayloadSummary {
  const kind = payloadKind(value);
  const shape = kind === "object" && value
    ? { keys: Object.keys(value as Record<string, unknown>).slice(0, 20), keyCount: Object.keys(value as Record<string, unknown>).length }
    : kind === "array"
      ? { itemCount: (value as unknown[]).length }
      : {};
  try {
    const serialized = JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item) ?? "null";
    return {
      kind,
      characters: serialized.length,
      bytes: Buffer.byteLength(serialized, "utf8"),
      ...shape,
    };
  } catch {
    return { kind, characters: 0, bytes: 0, ...shape, serializationError: true };
  }
}

export function providerPromptTokens(usage: TokenUsageSample): number {
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

type TurnState = {
  index: number;
  modelSpan?: TraceHandle;
  usage?: TokenUsageSample;
};

type PendingTool = {
  toolCallId: string;
  turnIndex: number;
  span?: TraceHandle;
  before?: TokenUsageSample;
  promptTokensBefore?: number;
  finished: boolean;
};

export type ToolStartObservation = Readonly<{
  turnIndex: number;
  modelSpan?: TraceHandle;
  before?: TokenUsageSample;
  promptTokensBefore?: number;
}>;

export type ToolTokenUpdate = Readonly<{
  toolCallId: string;
  span?: TraceHandle;
  turnIndex: number;
  before?: TokenUsageSample;
  after: TokenUsageSample;
  promptTokensBefore?: number;
  promptTokensAfter: number;
  promptTokenDelta?: number;
  batchSize: number;
}>;

/** Correlates pi model cycles and their tool batches without inventing per-tool token attribution. */
export class AgentTurnObservation {
  private runId?: string;
  private nextTurnIndex = 0;
  private current?: TurnState;
  private readonly pendingTools = new Map<string, PendingTool>();

  startTurn(runId: string): number {
    if (this.runId !== runId) {
      this.runId = runId;
      this.nextTurnIndex = 0;
      this.current = undefined;
      this.pendingTools.clear();
    }
    const index = this.nextTurnIndex++;
    this.current = { index };
    return index;
  }

  attachModelSpan(span: TraceHandle | undefined): void {
    if (this.current) this.current.modelSpan = span;
  }

  completeModel(sample: TokenUsageSample): { turnIndex: number; toolUpdates: ToolTokenUpdate[] } {
    if (!this.current) this.current = { index: this.nextTurnIndex++ };
    const turnIndex = this.current.index;
    this.current.usage = sample;
    const eligible = [...this.pendingTools.values()]
      .filter((tool) => tool.finished && tool.turnIndex < turnIndex);
    const batchSizes = new Map<number, number>();
    for (const tool of eligible) batchSizes.set(tool.turnIndex, (batchSizes.get(tool.turnIndex) ?? 0) + 1);
    const promptTokensAfter = providerPromptTokens(sample);
    const toolUpdates = eligible.map((tool): ToolTokenUpdate => ({
      toolCallId: tool.toolCallId,
      span: tool.span,
      turnIndex: tool.turnIndex,
      before: tool.before,
      after: sample,
      promptTokensBefore: tool.promptTokensBefore,
      promptTokensAfter,
      promptTokenDelta: tool.promptTokensBefore === undefined
        ? undefined
        : promptTokensAfter - tool.promptTokensBefore,
      batchSize: batchSizes.get(tool.turnIndex) ?? 1,
    }));
    for (const tool of eligible) this.pendingTools.delete(tool.toolCallId);
    return { turnIndex, toolUpdates };
  }

  startTool(toolCallId: string, span?: TraceHandle): ToolStartObservation | undefined {
    if (!this.current) return undefined;
    const before = this.current.usage;
    const tool: PendingTool = {
      toolCallId,
      turnIndex: this.current.index,
      span,
      before,
      promptTokensBefore: before ? providerPromptTokens(before) : undefined,
      finished: false,
    };
    this.pendingTools.set(toolCallId, tool);
    return {
      turnIndex: tool.turnIndex,
      modelSpan: this.current.modelSpan,
      before,
      promptTokensBefore: tool.promptTokensBefore,
    };
  }

  attachToolSpan(toolCallId: string, span: TraceHandle | undefined): void {
    const tool = this.pendingTools.get(toolCallId);
    if (tool) tool.span = span;
  }

  finishTool(toolCallId: string): PendingTool | undefined {
    const tool = this.pendingTools.get(toolCallId);
    if (tool) tool.finished = true;
    return tool;
  }

  currentTurnIndex(): number | undefined {
    return this.current?.index;
  }
}
