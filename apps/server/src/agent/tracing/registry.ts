/**
 * 按本地 chat_run.id 登记 TraceContext。
 * root 在 product finish 且 inflight jobs 清空后才 end。
 */
import type { AgentTracer, EndOptions, MappedError, RootAttrs, SpanAttrs, TraceContext, TraceHandle } from "./types.js";

const ROOT_TIMEOUT_MS = 15 * 60 * 1_000;

export class TraceRegistry {
  private readonly byRun = new Map<string, TraceContext>();
  private readonly timeouts = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly tracer: AgentTracer) {}

  get enabled() {
    return this.tracer.enabled;
  }

  getTracer() {
    return this.tracer;
  }

  startRoot(attrs: RootAttrs): TraceContext {
    const existing = this.byRun.get(attrs.run_id);
    if (existing && !existing.closed) return existing;
    const root = this.tracer.startRoot(attrs);
    const ctx: TraceContext = {
      runId: attrs.run_id,
      projectId: attrs.project_id,
      threadId: attrs.thread_id,
      root,
      smithRunId: root.id,
      inflightJobs: new Set(),
      toolSpans: new Map(),
      productFinished: false,
      closed: false,
    };
    this.byRun.set(attrs.run_id, ctx);
    this.armTimeout(attrs.run_id);
    return ctx;
  }

  get(runId: string | undefined): TraceContext | undefined {
    if (!runId) return undefined;
    const ctx = this.byRun.get(runId);
    return ctx && !ctx.closed ? ctx : undefined;
  }

  startSpan(runId: string | undefined, attrs: SpanAttrs, parent?: TraceHandle): TraceHandle | undefined {
    const ctx = this.get(runId);
    if (!ctx) return undefined;
    return this.tracer.startSpan(parent ?? ctx.root, {
      ...attrs,
      metadata: {
        project_id: ctx.projectId,
        thread_id: ctx.threadId,
        run_id: ctx.runId,
        ...attrs.metadata,
      },
    });
  }

  end(handle: TraceHandle | undefined, out?: EndOptions) {
    if (!handle) return;
    this.tracer.end(handle, out);
  }

  recordError(handle: TraceHandle | undefined, err: MappedError) {
    if (!handle) return;
    this.tracer.recordError(handle, err);
  }

  /** 产品侧 finishRun 后调用；有 inflight job 则等 job 终态。 */
  markProductFinished(runId: string, out?: EndOptions) {
    const ctx = this.byRun.get(runId);
    if (!ctx || ctx.closed) return;
    ctx.productFinished = true;
    (ctx as TraceContext & { pendingEnd?: EndOptions }).pendingEnd = out;
    this.maybeClose(runId);
  }

  trackJob(runId: string | undefined, jobId: string) {
    const ctx = this.get(runId);
    if (!ctx) return;
    ctx.inflightJobs.add(jobId);
  }

  completeJob(runId: string | undefined, jobId: string) {
    const ctx = this.byRun.get(runId ?? "");
    if (!ctx || ctx.closed) return;
    ctx.inflightJobs.delete(jobId);
    this.maybeClose(runId!);
  }

  /** boot：强制 end 仍 open 的 root（进程崩溃恢复）。 */
  forceClose(runId: string, err?: MappedError) {
    const ctx = this.byRun.get(runId);
    if (!ctx || ctx.closed) return;
    if (err) this.tracer.recordError(ctx.root, err);
    else this.tracer.end(ctx.root, { status: "error", error: err ?? { error_code: "INTERNAL", message: "服务重启或异常退出" } });
    ctx.closed = true;
    this.clearTimeout(runId);
    this.byRun.delete(runId);
  }

  forceCloseAll(message = "服务关闭") {
    for (const runId of [...this.byRun.keys()]) {
      this.forceClose(runId, { error_code: "INTERNAL", message });
    }
  }

  async flush() {
    await this.tracer.flush();
  }

  private maybeClose(runId: string) {
    const ctx = this.byRun.get(runId);
    if (!ctx || ctx.closed) return;
    if (!ctx.productFinished) return;
    if (ctx.inflightJobs.size > 0) return;
    const pending = (ctx as TraceContext & { pendingEnd?: EndOptions }).pendingEnd;
    this.tracer.end(ctx.root, pending ?? { status: "ok" });
    ctx.closed = true;
    this.clearTimeout(runId);
    this.byRun.delete(runId);
  }

  private armTimeout(runId: string) {
    this.clearTimeout(runId);
    this.timeouts.set(runId, setTimeout(() => {
      this.forceClose(runId, { error_code: "INTERNAL", message: "trace root timeout" });
    }, ROOT_TIMEOUT_MS));
  }

  private clearTimeout(runId: string) {
    const t = this.timeouts.get(runId);
    if (t) clearTimeout(t);
    this.timeouts.delete(runId);
  }
}
