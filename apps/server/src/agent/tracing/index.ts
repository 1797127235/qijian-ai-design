import type { ServerConfig } from "../../config.js";
import { LangSmithTracer } from "./langsmith-tracer.js";
import { NoopTracer } from "./noop.js";
import { TraceRegistry } from "./registry.js";
import type { AgentTracer } from "./types.js";

export type { AgentTracer, ErrorCode, MappedError, RootAttrs, SpanAttrs, TraceContext, TraceHandle } from "./types.js";
export { mapError, mapErrorFromUnknown, isErrorCode } from "./map-error.js";
export { capJson, pickMeta, imageMeta, truncateText } from "./redact.js";
export { TraceRegistry } from "./registry.js";
export { NoopTracer } from "./noop.js";

export function createAgentTracer(config: ServerConfig): AgentTracer {
  if (!config.langsmithTracing) return new NoopTracer();
  if (!config.langsmithApiKey) {
    console.warn("[langsmith] LANGSMITH_TRACING=true but LANGSMITH_API_KEY missing; using Noop");
    return new NoopTracer();
  }
  return new LangSmithTracer(config);
}

export function createTraceRegistry(config: ServerConfig): TraceRegistry {
  return new TraceRegistry(createAgentTracer(config));
}
