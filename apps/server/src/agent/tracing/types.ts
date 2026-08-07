/** H7 Agent 观测：错误码与 Tracer 契约。 */

export type ErrorCode =
  | "VALIDATION"
  | "SOURCE_NOT_FOUND"
  | "PROJECT_MISMATCH"
  | "PROVIDER_4XX"
  | "PROVIDER_5XX"
  | "PROVIDER_TIMEOUT"
  | "USER_ABORT"
  | "JOB_CANCELLED"
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

export interface EndOptions {
  status: "ok" | "error";
  outputs?: Record<string, unknown>;
  error?: MappedError;
}

export interface AgentTracer {
  enabled: boolean;
  startRoot(attrs: RootAttrs): TraceHandle;
  startSpan(parent: TraceHandle, attrs: SpanAttrs): TraceHandle;
  end(handle: TraceHandle, out?: EndOptions): void;
  recordError(handle: TraceHandle, err: MappedError): void;
  flush(): Promise<void>;
}

export interface TraceContext {
  runId: string;
  projectId: string;
  threadId: string;
  root: TraceHandle;
  smithRunId: string;
  inflightJobs: Set<string>;
  toolSpans: Map<string, TraceHandle>;
  modelSpan?: TraceHandle;
  productFinished: boolean;
  closed: boolean;
}
