/** H7 Agent 观测：错误码与 Tracer 契约。 */
import type { TokenUsageAggregate } from "../usage-metrics.js";
import type { CacheFingerprint } from "../cache-contract.js";

export type ErrorCode =
  | "VALIDATION"
  | "SOURCE_NOT_FOUND"
  | "PROJECT_MISMATCH"
  | "PROVIDER_4XX"
  | "PROVIDER_5XX"
  | "PROVIDER_TIMEOUT"
  | "USER_ABORT"
  | "JOB_CANCELLED"
  | "POLICY_DENIED"
  | "INTERNAL"
  | "SERIALIZE";

export interface MappedError {
  error_code: ErrorCode;
  message: string;
}

export interface RootAttrs {
  project_id: string;
  thread_id: string;
  run_id: string;
  client_message_id?: string;
  inputs?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface SpanAttrs {
  name: string;
  run_type?: "chain" | "tool" | "llm" | "retriever" | "embedding" | "prompt" | "parser";
  inputs?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface TraceHandle {
  readonly id: string;
  readonly runId: string;
}

/** 可跨进程/队列持久化的 LangSmith 父链上下文。 */
export interface TraceContextCarrier {
  readonly traceId: string;
  readonly parentRunId: string;
  readonly langsmithTrace: string;
  readonly baggage?: string;
}

export interface EndOptions {
  status: "ok" | "error";
  outputs?: Record<string, unknown>;
  error?: MappedError;
}

export interface AgentTracer {
  enabled: boolean;
  startRoot(attrs: RootAttrs): TraceHandle;
  startSpan(parent: TraceHandle, attrs: SpanAttrs): TraceHandle;
  captureContext(handle: TraceHandle): TraceContextCarrier | undefined;
  startRemoteSpan(context: TraceContextCarrier, attrs: SpanAttrs, runId: string): TraceHandle;
  end(handle: TraceHandle, out?: EndOptions): void;
  /** Patch outputs after a span ended while preserving its execution duration. */
  annotate(handle: TraceHandle, outputs: Record<string, unknown>): void;
  recordError(handle: TraceHandle, err: MappedError): void;
  flush(): Promise<void>;
}

/** 本 run 内模型 turn 的 token/cache 累加（L2 挂 root outputs）。 */
export type TraceUsageTotals = TokenUsageAggregate;

export interface TraceContext {
  runId: string;
  projectId: string;
  threadId: string;
  root: TraceHandle;
  smithRunId: string;
  inflightJobs: Set<string>;
  toolSpans: Map<string, TraceHandle>;
  modelSpan?: TraceHandle;
  /** assistant message_end 累加的 usage */
  usageTotals?: TraceUsageTotals;
  /** 最近一次 provider 请求对应的上下文指纹。 */
  cacheFingerprint?: CacheFingerprint;
  productFinished: boolean;
  closed: boolean;
}
