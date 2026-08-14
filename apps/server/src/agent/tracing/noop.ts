import type { AgentTracer, EndOptions, MappedError, RootAttrs, SpanAttrs, TraceContextCarrier, TraceHandle } from "./types.js";

class NoopHandle implements TraceHandle {
  constructor(readonly id: string, readonly runId: string) {}
}

/** 关闭 tracing 时的空实现：零网络、零分配热点（仅轻量对象）。 */
export class NoopTracer implements AgentTracer {
  readonly enabled = false;
  private seq = 0;

  startRoot(attrs: RootAttrs): TraceHandle {
    return new NoopHandle(`noop-root-${++this.seq}`, attrs.run_id);
  }

  startSpan(parent: TraceHandle, _attrs: SpanAttrs): TraceHandle {
    return new NoopHandle(`noop-span-${++this.seq}`, parent.runId);
  }

  captureContext(_handle: TraceHandle): TraceContextCarrier | undefined { return undefined; }
  startRemoteSpan(_context: TraceContextCarrier, _attrs: SpanAttrs, runId: string): TraceHandle {
    return new NoopHandle(`noop-remote-span-${++this.seq}`, runId);
  }

  end(_handle: TraceHandle, _out?: EndOptions) {}
  annotate(_handle: TraceHandle, _outputs: Record<string, unknown>) {}
  recordError(_handle: TraceHandle, _err: MappedError) {}
  async flush() {}
}
