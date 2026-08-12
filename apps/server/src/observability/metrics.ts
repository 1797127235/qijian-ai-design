import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";

export type QueueSnapshot = Readonly<{
  waiting: number;
  delayed: number;
  active: number;
  failed: number;
  workers: number;
  oldestWaitingSeconds: number;
}>;

export class RuntimeMetrics {
  readonly registry = new Registry();
  private queueCollector?: () => Promise<QueueSnapshot>;
  private queueSnapshotCache?: { expiresAt: number; value: Promise<QueueSnapshot | undefined> };
  private lastQueueSnapshot?: QueueSnapshot;

  private readonly httpRequests = new Counter({
    name: "qijian_http_requests_total",
    help: "HTTP requests by route and status class",
    labelNames: ["method", "route", "status_class"] as const,
    registers: [this.registry],
  });
  private readonly httpDuration = new Histogram({
    name: "qijian_http_request_duration_seconds",
    help: "HTTP request duration by route",
    labelNames: ["method", "route", "status_class"] as const,
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 15, 60],
    registers: [this.registry],
  });
  private readonly agentRuns = new Counter({
    name: "qijian_agent_runs_total",
    help: "Agent product runs by outcome and source",
    labelNames: ["status", "source"] as const,
    registers: [this.registry],
  });
  private readonly agentRunDuration = new Histogram({
    name: "qijian_agent_run_duration_seconds",
    help: "Agent product run duration",
    labelNames: ["status", "source"] as const,
    buckets: [0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 900],
    registers: [this.registry],
  });
  private readonly toolRuns = new Counter({
    name: "qijian_agent_tool_calls_total",
    help: "Agent tool calls by tool and outcome",
    labelNames: ["tool", "status"] as const,
    registers: [this.registry],
  });
  private readonly toolDuration = new Histogram({
    name: "qijian_agent_tool_duration_seconds",
    help: "Agent tool execution duration",
    labelNames: ["tool", "status"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 15, 60],
    registers: [this.registry],
  });
  private readonly modelTokens = new Counter({
    name: "qijian_agent_model_tokens_total",
    help: "Agent model tokens by usage kind",
    labelNames: ["kind"] as const,
    registers: [this.registry],
  });
  private readonly cacheHitRatio = new Histogram({
    name: "qijian_agent_cache_read_hit_ratio",
    help: "Per-model-turn prompt cache read hit ratio",
    buckets: [0.1, 0.25, 0.5, 0.75, 0.9, 0.92, 0.95, 0.98, 1],
    registers: [this.registry],
  });
  private readonly tasks = new Counter({
    name: "qijian_tasks_total",
    help: "Background task outcomes",
    labelNames: ["kind", "status"] as const,
    registers: [this.registry],
  });
  private readonly taskDuration = new Histogram({
    name: "qijian_task_duration_seconds",
    help: "Background task processing duration",
    labelNames: ["kind", "status"] as const,
    buckets: [0.1, 0.5, 1, 2.5, 5, 15, 30, 60, 120, 300, 600, 900],
    registers: [this.registry],
  });
  private readonly dispatcherTasks = new Counter({
    name: "qijian_dispatcher_tasks_total",
    help: "Outbox dispatcher task outcomes",
    labelNames: ["outcome"] as const,
    registers: [this.registry],
  });
  private readonly reconcilerActions = new Counter({
    name: "qijian_reconciler_actions_total",
    help: "Queue reconciler actions and dependency errors",
    labelNames: ["outcome"] as const,
    registers: [this.registry],
  });
  private readonly queueJobs: Gauge<"state">;
  private readonly queueWorkers = new Gauge({
    name: "qijian_queue_workers",
    help: "BullMQ workers visible to the queue",
    registers: [this.registry],
    collect: async () => {
      if (!this.queueCollector) return;
      const snapshot = await this.collectQueueSnapshot();
      if (snapshot) this.queueWorkers.set(snapshot.workers);
    },
  });
  private readonly queueOldestWaiting = new Gauge({
    name: "qijian_queue_oldest_waiting_seconds",
    help: "Age of the oldest waiting or delayed BullMQ job",
    registers: [this.registry],
    collect: async () => {
      if (!this.queueCollector) return;
      const snapshot = await this.collectQueueSnapshot();
      if (snapshot) this.queueOldestWaiting.set(snapshot.oldestWaitingSeconds);
    },
  });
  private readonly queueSnapshotAvailable = new Gauge({
    name: "qijian_queue_snapshot_available",
    help: "Whether the latest BullMQ queue snapshot collection succeeded",
    registers: [this.registry],
    collect: async () => {
      if (this.queueCollector) await this.collectQueueSnapshot();
    },
  });
  private readonly subsystemReady = new Gauge({
    name: "qijian_subsystem_ready",
    help: "Dependency readiness (1 ready, 0 unavailable)",
    labelNames: ["subsystem"] as const,
    registers: [this.registry],
  });
  private readonly staleRuns = new Counter({
    name: "qijian_agent_stale_runs_interrupted_total",
    help: "Agent runs interrupted by the background watchdog",
    registers: [this.registry],
  });
  private readonly traceDrops = new Counter({
    name: "qijian_trace_export_dropped_total",
    help: "Trace export operations dropped by the bounded exporter queue",
    registers: [this.registry],
  });
  private readonly traceErrors = new Counter({
    name: "qijian_trace_export_errors_total",
    help: "Trace export operations that failed",
    registers: [this.registry],
  });
  private readonly alertNotifications = new Counter({
    name: "qijian_alert_notifications_total",
    help: "Alertmanager webhook notifications received by status",
    labelNames: ["status"] as const,
    registers: [this.registry],
  });

  constructor(service: string, options: { defaultMetrics?: boolean } = {}) {
    this.registry.setDefaultLabels({ service });
    this.queueJobs = new Gauge({
      name: "qijian_queue_jobs",
      help: "BullMQ jobs by scheduling state",
      labelNames: ["state"] as const,
      registers: [this.registry],
      collect: async () => {
        if (!this.queueCollector) return;
        const snapshot = await this.collectQueueSnapshot();
        if (!snapshot) return;
        this.queueJobs.set({ state: "waiting" }, snapshot.waiting);
        this.queueJobs.set({ state: "delayed" }, snapshot.delayed);
        this.queueJobs.set({ state: "active" }, snapshot.active);
        this.queueJobs.set({ state: "failed" }, snapshot.failed);
      },
    });
    if (options.defaultMetrics !== false) {
      collectDefaultMetrics({ register: this.registry, prefix: "qijian_node_" });
    }
  }

  observeHttp(input: { method: string; route: string; status: number; durationSeconds: number }): void {
    const labels = {
      method: input.method.toUpperCase(),
      route: input.route,
      status_class: `${Math.floor(input.status / 100)}xx`,
    };
    this.httpRequests.inc(labels);
    this.httpDuration.observe(labels, input.durationSeconds);
  }

  observeAgentRun(input: { status: string; source: string; durationSeconds: number }): void {
    const labels = { status: input.status, source: input.source };
    this.agentRuns.inc(labels);
    this.agentRunDuration.observe(labels, input.durationSeconds);
  }

  observeTool(input: { tool: string; status: string; durationSeconds: number }): void {
    const labels = { tool: input.tool, status: input.status };
    this.toolRuns.inc(labels);
    this.toolDuration.observe(labels, input.durationSeconds);
  }

  observeModelUsage(input: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    hitRate: number | null;
  }): void {
    this.modelTokens.inc({ kind: "input" }, input.input);
    this.modelTokens.inc({ kind: "output" }, input.output);
    this.modelTokens.inc({ kind: "cache_read" }, input.cacheRead);
    this.modelTokens.inc({ kind: "cache_write" }, input.cacheWrite);
    if (input.hitRate !== null) this.cacheHitRatio.observe(input.hitRate);
  }

  observeTask(input: { kind: string; status: string; durationSeconds: number }): void {
    const labels = { kind: input.kind, status: input.status };
    this.tasks.inc(labels);
    this.taskDuration.observe(labels, input.durationSeconds);
  }

  observeDispatcher(summary: {
    claimed: number;
    enqueued: number;
    released: number;
    failed: number;
    deadLettered: number;
  }): void {
    for (const [outcome, count] of Object.entries(summary)) {
      if (count > 0) this.dispatcherTasks.inc({ outcome }, count);
    }
  }

  observeReconciler(summary: {
    reclaimed: number;
    requeued: number;
    needsReview: number;
    redisErrors: number;
  }): void {
    for (const [outcome, count] of Object.entries(summary)) {
      if (count > 0) this.reconcilerActions.inc({ outcome }, count);
    }
  }

  bindQueueCollector(collector: () => Promise<QueueSnapshot>): void {
    this.queueCollector = collector;
    this.queueSnapshotCache = undefined;
    this.queueSnapshotAvailable.set(0);
  }

  private collectQueueSnapshot(): Promise<QueueSnapshot | undefined> {
    const now = Date.now();
    if (this.queueSnapshotCache && this.queueSnapshotCache.expiresAt >= now) {
      return this.queueSnapshotCache.value;
    }
    const value = this.queueCollector!()
      .then((snapshot) => {
        this.lastQueueSnapshot = snapshot;
        this.queueSnapshotAvailable.set(1);
        return snapshot;
      })
      .catch(() => {
        this.queueSnapshotAvailable.set(0);
        return this.lastQueueSnapshot;
      });
    this.queueSnapshotCache = { expiresAt: now + 100, value };
    return value;
  }

  setReady(subsystem: string, ready: boolean): void {
    this.subsystemReady.set({ subsystem }, ready ? 1 : 0);
  }

  observeStaleRuns(count: number): void {
    if (count > 0) this.staleRuns.inc(count);
  }

  observeTraceDrop(count = 1): void {
    if (count > 0) this.traceDrops.inc(count);
  }

  observeTraceError(count = 1): void {
    if (count > 0) this.traceErrors.inc(count);
  }

  observeAlert(status: string, count = 1): void {
    const bounded = status === "firing" || status === "resolved" ? status : "unknown";
    if (count > 0) this.alertNotifications.inc({ status: bounded }, count);
  }

  text(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
