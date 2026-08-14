import { mapErrorFromUnknown } from "../agent/tracing/map-error.js";
import type { AgentTracer, TraceContextCarrier } from "../agent/tracing/types.js";

export type TracedTask = Readonly<{
  id: string;
  runId?: string | null;
  kind: string;
  traceContext?: TraceContextCarrier | null;
}>;

function terminalStatus(result: unknown): string {
  if (!result || typeof result !== "object") return "succeeded";
  const status = (result as { status?: unknown }).status;
  return typeof status === "string" ? status : "succeeded";
}

function terminalError(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const error = (result as { error?: unknown }).error;
  return typeof error === "string" ? error : undefined;
}

/** Continue the persisted Agent parent across the BullMQ process boundary. */
export async function runTaskWithTrace<T>(
  tracer: AgentTracer,
  task: TracedTask,
  operation: () => Promise<T>,
): Promise<T> {
  if (!tracer.enabled || !task.traceContext) return operation();

  const runId = task.runId ?? task.id;
  const span = tracer.startRemoteSpan(task.traceContext, {
    name: `task.${task.kind}`,
    run_type: "tool",
    inputs: { task_id: task.id },
    metadata: { job_id: task.id, kind: task.kind },
  }, runId);
  try {
    const result = await operation();
    const status = terminalStatus(result);
    const error = terminalError(result);
    if (status === "failed" || status === "needs_review" || status === "cancelled_with_side_effect") {
      tracer.recordError(span, mapErrorFromUnknown(error ?? `task ended with ${status}`));
    } else {
      tracer.end(span, { status: "ok", outputs: { status } });
    }
    return result;
  } catch (error) {
    tracer.recordError(span, mapErrorFromUnknown(error));
    throw error;
  }
}
