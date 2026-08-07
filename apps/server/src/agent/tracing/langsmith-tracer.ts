/**
 * LangSmith RunTree 封装：fire-and-forget 出站，失败只 log。
 * 关键：子 span 必须等父 postRun 完成后再 post，否则 Smith 只显示孤 root。
 */
import { Client, RunTree } from "langsmith";
import type { ServerConfig } from "../../config.js";
import { BoundedAsyncQueue } from "./queue.js";
import { capJson, pickMeta, truncateText } from "./redact.js";
import type { AgentTracer, EndOptions, MappedError, RootAttrs, SpanAttrs, TraceHandle } from "./types.js";

interface LiveHandle extends TraceHandle {
  tree: RunTree;
  posted: boolean;
  /** 串行化 post/end，保证父子顺序 */
  chain: Promise<void>;
}

export class LangSmithTracer implements AgentTracer {
  readonly enabled = true;
  private readonly client: Client;
  private readonly project: string;
  private readonly debugSync: boolean;
  private readonly queue = new BoundedAsyncQueue(200, 2);
  private readonly handles = new Map<string, LiveHandle>();

  constructor(config: Pick<ServerConfig, "langsmithApiKey" | "langsmithProject" | "langsmithEndpoint" | "langsmithDebugSync">) {
    this.project = config.langsmithProject || "default";
    this.debugSync = Boolean(config.langsmithDebugSync);
    this.client = new Client({
      apiKey: config.langsmithApiKey,
      apiUrl: config.langsmithEndpoint || undefined,
    });
  }

  startRoot(attrs: RootAttrs): TraceHandle {
    const inputs = attrs.inputs ? capJson(attrs.inputs) as Record<string, unknown> : {};
    if (typeof inputs === "object" && inputs && "text" in inputs && typeof inputs.text === "string") {
      const t = truncateText(inputs.text);
      inputs.text = t.text;
      if (t.truncated) inputs.truncated = true;
    }
    const tree = new RunTree({
      name: "agent.prompt",
      run_type: "chain",
      project_name: this.project,
      client: this.client,
      inputs: inputs as Record<string, unknown>,
      metadata: pickMeta({
        project_id: attrs.project_id,
        thread_id: attrs.thread_id,
        run_id: attrs.run_id,
        client_message_id: attrs.client_message_id,
        ...attrs.metadata,
      }),
    });
    const handle: LiveHandle = {
      id: tree.id,
      runId: attrs.run_id,
      tree,
      posted: false,
      chain: Promise.resolve(),
    };
    this.handles.set(handle.id, handle);
    this.enqueue(handle, async () => {
      await tree.postRun();
      handle.posted = true;
    });
    return handle;
  }

  startSpan(parent: TraceHandle, attrs: SpanAttrs): TraceHandle {
    const parentHandle = this.handles.get(parent.id);
    if (!parentHandle) {
      // parent 已 end 并移出 map：仍尝试用 parent_run_id 挂接
      return this.startDetachedChild(parent, attrs);
    }
    const child = parentHandle.tree.createChild({
      name: attrs.name,
      run_type: attrs.run_type ?? "chain",
      inputs: (attrs.inputs ? capJson(attrs.inputs) : {}) as Record<string, unknown>,
      metadata: pickMeta({ run_id: parent.runId, ...attrs.metadata }),
    });
    const handle: LiveHandle = {
      id: child.id,
      runId: parent.runId,
      tree: child,
      posted: false,
      chain: Promise.resolve(),
    };
    this.handles.set(handle.id, handle);
    // 必须等父链完成 post，再 post 子，否则 Smith UI 只有 root
    this.enqueue(handle, async () => {
      await parentHandle.chain;
      if (!parentHandle.posted) {
        try {
          await parentHandle.tree.postRun();
          parentHandle.posted = true;
        } catch (error) {
          console.warn("[langsmith] parent postRun failed:", error instanceof Error ? error.message : error);
        }
      }
      await child.postRun();
      handle.posted = true;
    });
    return handle;
  }

  end(handle: TraceHandle, out?: EndOptions) {
    const live = this.handles.get(handle.id);
    if (!live) return;
    const outputs = out?.outputs ? capJson(out.outputs) as Record<string, unknown> : undefined;
    const error = out?.status === "error"
      ? (out.error ? `${out.error.error_code}: ${out.error.message}` : "error")
      : undefined;
    this.enqueue(live, async () => {
      if (!live.posted) {
        try {
          await live.tree.postRun();
          live.posted = true;
        } catch { /* ignore */ }
      }
      await live.tree.end(outputs, error);
      await live.tree.patchRun();
      this.handles.delete(handle.id);
    });
  }

  recordError(handle: TraceHandle, err: MappedError) {
    this.end(handle, { status: "error", error: err, outputs: { error_code: err.error_code } });
  }

  async flush() {
    // 等所有 handle 链 + 队列
    const chains = [...this.handles.values()].map((h) => h.chain.catch(() => undefined));
    await Promise.all(chains);
    await this.queue.drain(5_000);
  }

  /** 父 handle 已释放时，用 parent_run_id 直接建子 run */
  private startDetachedChild(parent: TraceHandle, attrs: SpanAttrs): TraceHandle {
    const tree = new RunTree({
      name: attrs.name,
      run_type: attrs.run_type ?? "chain",
      project_name: this.project,
      client: this.client,
      parent_run_id: parent.id,
      inputs: (attrs.inputs ? capJson(attrs.inputs) : {}) as Record<string, unknown>,
      metadata: pickMeta({ run_id: parent.runId, ...attrs.metadata }),
    });
    const handle: LiveHandle = {
      id: tree.id,
      runId: parent.runId,
      tree,
      posted: false,
      chain: Promise.resolve(),
    };
    this.handles.set(handle.id, handle);
    this.enqueue(handle, async () => {
      await tree.postRun();
      handle.posted = true;
    });
    return handle;
  }

  private enqueue(handle: LiveHandle, task: () => Promise<void>) {
    // 真正的网络工作放进 BoundedAsyncQueue，由 concurrency 限流；
    // handle.chain 只串行等待「已入队的前序任务完成」，不提前启动 fetch。
    const run = async () => {
      try {
        await task();
      } catch (error) {
        console.warn("[langsmith] export failed:", error instanceof Error ? error.message : error);
      }
    };
    if (this.debugSync) {
      handle.chain = handle.chain.then(run, run);
      void handle.chain;
      return;
    }
    const previous = handle.chain;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    handle.chain = previous.then(() => gate, () => gate);
    this.queue.enqueue(async () => {
      try {
        await previous.catch(() => undefined);
        await run();
      } finally {
        release();
      }
    });
  }
}
