/**
 * 服务端入口：依赖装配 + HTTP/WS 启动。
 *
 * 装配顺序由内向外：
 *   1) 基础设施：config / db pool
 *   2) 领域服务：artifacts / desks / files / chats / image generator
 *   3) 复合服务：CanvasGenerateService（聚合 artifacts+desks+files+effects 给 Agent 调用）
 *   4) 文件引用检查器互注册：chats / artifacts 谁持有 file_id，FileStorage 才能算孤儿
 *   5) BullMQ 资产任务：PostgreSQL outbox + Redis 队列 + Worker
 *   6) AgentSessionRegistry：把 pi-coding-agent 实例与上述服务绑定
 *   7) ChatGateway：所有 event 统一入口，publish 函数先占位再回填避免循环依赖
 */
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { WebSocketServer } from "ws";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { HonoAdapter } from "@bull-board/hono";
import { JobWakeService } from "./agent/async-job/job-wake.js";
import { AgentJobStore } from "./agent/async-job/store.js";
import { ChatGateway } from "./agent/chat-gateway.js";
import { createDeskContentChangedHandler } from "./agent/desk-changed-broadcast.js";
import type { EventSink } from "./agent/events.js";
import { AgentSessionRegistry } from "./agent/session-registry.js";
import { createTraceRegistry } from "./agent/tracing/index.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db/client.js";
import { createHttpApp } from "./http/app.js";
import { ArtifactService } from "./services/artifact-service.js";
import { CanvasGenerateService } from "./services/canvas-generate-service.js";
import { ChatService } from "./services/chat-service.js";
import { DeskStateService } from "./services/desk-state-service.js";
import { FileStorage } from "./services/file-storage.js";
import { ImageCaptionService } from "./services/image-caption-service.js";
import { ImageCaptionStore } from "./services/image-caption-store.js";
import { HttpImageGenerator } from "./services/image-generator.js";
import { warnDuplicateImageModels } from "./services/image-providers.js";
import { ProjectAutoNamer } from "./services/project-namer.js";
import { FileGcScheduler } from "./services/file-gc-scheduler.js";
import { ProjectCoverService } from "./services/project-cover-service.js";
import { eq } from "drizzle-orm";
import { projects } from "./db/schema.js";
import { BullMqQueueAdapter } from "./tasks/bullmq/queue.js";
import { TaskOutboxDispatcher } from "./tasks/dispatcher.js";
import { TaskQueueReconciler } from "./tasks/reconciler.js";
import { TaskStore } from "./tasks/task-store.js";
import { AssetTaskSubmissionService } from "./tasks/asset-task-submission.js";
import { TaskEventStore } from "./tasks/event-store.js";
import { TaskJobWakePoller } from "./tasks/job-wake-poller.js";
import { TaskDeskRefreshPoller } from "./tasks/desk-refresh-poller.js";
import { AssetBatchSubmissionService } from "./tasks/asset-batch-submission.js";
import { TaskCancellationService } from "./tasks/cancellation.js";
import { ImageTaskExecutor } from "./tasks/image-task-executor.js";
import { ProjectMemoryService } from "./agent/memory/service.js";
import { RuntimeMetrics } from "./observability/metrics.js";
import { StructuredLogger } from "./observability/logger.js";
import { RuntimeReadiness } from "./observability/readiness.js";

// —— 基础设施 ——
const config = loadConfig();
const metrics = new RuntimeMetrics("qijian-api");
const logger = new StructuredLogger("qijian-api");
// 多网关 model id 冲突：先注册者生效（见 image-providers 约定）
warnDuplicateImageModels(config.imageProviders);
const { db, pool } = createDatabase(config);

// —— 领域服务（单实体）——
const artifacts = new ArtifactService(db);
const desks = new DeskStateService(db);
const files = new FileStorage(db, config);
const effects = new HttpImageGenerator(config, files);
const chats = new ChatService(db);
const memory = new ProjectMemoryService(db);
const captionStore = new ImageCaptionStore(db);
const captionService = new ImageCaptionService(files, captionStore, config);
artifacts.setImageReadyHandler((projectId, fileId) => captionService.kick(projectId, fileId));

// —— 复合服务：Agent 写桌唯一通路（generate_from_desk）——
// 拼装 artifacts+desks+files+effects 四个原子服务，让 Agent 一次调用就能落桌
const generate = new CanvasGenerateService(db, artifacts, desks, files, effects, captionService);
// 文件孤儿检查依赖 chats/artifacts 谁持引用，先建好服务再回填
// cover checker：projects.cover_file_id 持有封面引用，防 deleteUnattached 误扫
const coverRefs = {
  async referencesFile(fileId: string) {
    const [row] = await db.select({ id: projects.id }).from(projects).where(eq(projects.coverFileId, fileId)).limit(1);
    return Boolean(row);
  },
};
files.setReferenceCheckers([chats, artifacts, coverRefs]);

// 人看封面（派生缓存）：桌面实质变化 → 防抖重渲 → 存 stored_files 并回填 projects.cover_*
const covers = new ProjectCoverService({
  snapshot: (projectId) => desks.snapshot(projectId),
  getCover: (projectId) => desks.getProjectCover(projectId),
  setCover: (projectId, fileId, revision) => desks.setProjectCover(projectId, fileId, revision),
  originalFilenames: (projectId, fileIds) => files.originalFilenames(projectId, fileIds),
  readImageBytes: async (projectId, fileId) => {
    const stored = await files.getById(fileId);
    if (!stored || stored.projectId !== projectId) return null;
    return files.read(stored.objectKey);
  },
  putFile: (projectId, filename, mediaType, bytes) => files.put(projectId, filename, mediaType, bytes),
  deleteFile: (projectId, fileId) => files.deleteUnattached(projectId, fileId).then(() => undefined),
  onError: (error, projectId) => {
    console.warn(`[cover] render failed for project ${projectId}:`, error instanceof Error ? error.message : error);
  },
});
// publish 先用 no-op 占位，等 ChatGateway 构造好再回填成 chat.emit
// HTTP 写桌也走同一 listener → object_changed，跨 tab refetch（无 artifactId 不抢焦点）
let publish: EventSink = () => undefined;
const onDeskContentChanged = createDeskContentChangedHandler(
  (projectId) => covers.schedule(projectId),
  (event) => publish(event),
);
desks.setDeskChangedListener(onDeskContentChanged);
artifacts.setDeskChangedListener(onDeskContentChanged);
// 删物件只标记脏；按项目合并后再扫孤儿（默认 minAge 1h，不伤会话 undo）
const fileGc = new FileGcScheduler({
  gc: (projectId) => files.gcUnattached({ projectId }),
  onFinished: (projectId, result) => {
    if (result.deleted > 0 || result.errors > 0) {
      logger.info("file_gc_finished", { project_id: projectId, ...result });
    }
  },
  onError: (projectId, error) => {
    logger.warn("file_gc_failed", {
      project_id: projectId,
      error: error instanceof Error ? error.message : String(error),
    });
  },
});
artifacts.setObjectDeletedListener((projectId) => {
  fileGc.schedule(projectId);
});

// —— Agent 异步任务（job）——
const traces = createTraceRegistry(config, {
  onDrop: (droppedTotal) => {
    metrics.observeTraceDrop();
    if (droppedTotal === 1 || droppedTotal % 20 === 0) {
      logger.warn("trace_export_queue_dropped", { dropped_total: droppedTotal });
    }
  },
  onError: (error) => {
    metrics.observeTraceError();
    logger.warn("trace_export_failed", { error: error instanceof Error ? error.message : String(error) });
  },
});
const jobStore = new AgentJobStore(db);
const taskStore = new TaskStore(db);
const bullmq = new BullMqQueueAdapter(config);
metrics.bindQueueCollector(() => bullmq.snapshot());
const readiness = new RuntimeReadiness(pool, bullmq, metrics);
const taskCancellation = new TaskCancellationService(taskStore, bullmq);
const assetTaskSubmitter = new AssetTaskSubmissionService(taskStore, generate, desks, config, memory, traces);
const batchSubmitter = new AssetBatchSubmissionService(taskStore, generate, desks, config, memory);
const captions = captionStore;
// Agent 写桌：generate_from_desk → BullMQ 持久任务 → Worker
const sessions = new AgentSessionRegistry({
  artifacts,
  desks,
  effects,
  generate,
  chats,
  files,
  config,
  jobStore,
  taskCancellation,
  captions,
  traces,
  metrics,
  assetTaskSubmitter,
  memory,
  emit: (event) => publish(event),
});
// 方案 3 / 书中异步事件：job 终态 → 结构化 [JOB_EVENT] 回注轨迹并续跑
const jobWake = new JobWakeService(
  chats,
  async ({ projectId, threadId, text, taskId, runId, message, sourceTraceRootId, sourceTraceParentId }) => {
    // appendPrompt 已在 JobWakeService 完成（写轨迹喂模型）。
    // 不向客户端广播 chat_message：job-wake 是系统事件，不是用户气泡。
    void message;
    if (traces?.enabled) {
      const trace = sourceTraceRootId
        ? traces.startLinkedRoot({
          project_id: projectId,
          thread_id: threadId,
          run_id: runId,
          inputs: { wake: true, task_id: taskId },
          metadata: { source_trace_parent_id: sourceTraceParentId },
        }, sourceTraceRootId)
        : traces.startRoot({
          project_id: projectId,
          thread_id: threadId,
          run_id: runId,
          inputs: { wake: true, task_id: taskId },
        });
      await chats.setSmithRunId(runId, trace.smithRunId);
    }
    await sessions.runJobWake({ projectId, threadId, runId, text });
  },
  (projectId, threadId) => sessions.isThreadBusy(projectId, threadId),
);
sessions.setJobWake(jobWake);
const taskEventStore = new TaskEventStore(db);
const wakePoller = new TaskJobWakePoller(
  taskEventStore,
  jobStore,
  jobWake,
  (job) => traces.completeJob(job.runId, job.id),
);
const chat = new ChatGateway(sessions, chats, traces, metrics);
// publish 回填：从此刻起，Agent/Job 抛出的事件统一进 ChatGateway，由它按连接 fan-out
publish = chat.emit;
// Worker 终态 → object_changed（跨进程补推，前端 refreshDesk）
const deskRefreshPoller = new TaskDeskRefreshPoller(taskEventStore, taskStore, (event) => publish(event));
// 自动起名：走 publish（= chat.emit）fan-out project_renamed；需在 publish 回填后构造
const namer = new ProjectAutoNamer(desks, config, (event) => publish(event));
chat.namer = namer;

// BullMQ runtime: PG acceptance is durable; dispatcher/reconciler rebuild Redis scheduling.
// API 进程仅用 failPending 清死信 pending 卡（不跑 generate）
const imageTaskExecutor = new ImageTaskExecutor(files, effects, artifacts);
const dispatcher = new TaskOutboxDispatcher(taskStore, bullmq, {
  maxAttempts: config.taskOutboxMaxAttempts,
  retryBaseMs: config.taskOutboxBackoffMs,
  onDeadLetter: async ({ artifactId, payload, error }) => {
    if (artifactId && payload.kind === "image.generate") {
      await imageTaskExecutor.failPending(artifactId, payload, error);
    }
  },
});
const reconciler = new TaskQueueReconciler(taskStore, bullmq);
bullmq.queue.on("error", (error) => logger.warn("bullmq_queue_error", { error: error.message }));
bullmq.flowProducer.on("error", (error) => logger.warn("bullmq_flow_error", { error: error.message }));
let dispatching = false;
let reconciling = false;
let wakePolling = false;
let deskRefreshPolling = false;
let watchdogRunning = false;
const dispatchTimer = setInterval(() => {
  if (dispatching) return;
  dispatching = true;
  void dispatcher.dispatchOnce()
    .then((summary) => metrics.observeDispatcher(summary))
    .catch((error) => logger.error("dispatcher_failed", { error: error instanceof Error ? error.message : String(error) }))
    .finally(() => { dispatching = false; });
}, 250);
const reconcileTimer = setInterval(() => {
  if (reconciling) return;
  reconciling = true;
  void reconciler.reconcileOnce()
    .then((summary) => {
      metrics.observeReconciler(summary);
      if (summary.needsReview > 0 || summary.redisErrors > 0) {
        logger.warn("reconciler_degraded", summary);
      }
    })
    .catch((error) => logger.error("reconciler_failed", { error: error instanceof Error ? error.message : String(error) }))
    .finally(() => { reconciling = false; });
}, 30_000);
const wakeTimer = setInterval(() => {
  if (wakePolling) return;
  wakePolling = true;
  void wakePoller.pollOnce()
    .catch((error) => console.warn("[job-wake] event poll failed:", error instanceof Error ? error.message : error))
    .finally(() => { wakePolling = false; });
}, 500);
const deskRefreshTimer = setInterval(() => {
  if (deskRefreshPolling) return;
  deskRefreshPolling = true;
  void deskRefreshPoller.pollOnce()
    .catch((error) => console.warn("[desk-refresh] event poll failed:", error instanceof Error ? error.message : error))
    .finally(() => { deskRefreshPolling = false; });
}, 500);
const watchdogTimer = setInterval(() => {
  if (watchdogRunning) return;
  watchdogRunning = true;
  void chats.interruptStaleRunsGlobal(15 * 60 * 1_000)
    .then((count) => {
      metrics.observeStaleRuns(count);
      if (count > 0) logger.warn("agent_stale_runs_interrupted", { count });
    })
    .catch((error) => logger.error("agent_watchdog_failed", {
      error: error instanceof Error ? error.message : String(error),
    }))
    .finally(() => { watchdogRunning = false; });
}, 60_000);

// Bull Board is an operational read-only view over the same BullMQ queue.
const bullBoardServer = new HonoAdapter(serveStatic)
  .setBasePath(config.bullBoardPath);
createBullBoard({
  queues: [new BullMQAdapter(bullmq.queue, {
    // Never expose destructive controls without Basic Auth credentials.
    readOnlyMode: config.bullBoardReadOnly || !config.bullBoardUsername || !config.bullBoardPassword,
    displayName: "Asset Tasks",
    description: "BullMQ asset generation and naming tasks",
  })],
  serverAdapter: bullBoardServer,
  options: {
    uiConfig: {
      boardTitle: "Qijian Asset Tasks",
    },
  },
});
const bullBoard = bullBoardServer.registerPlugin();

/**
 * HTTP 启动 + WS upgrade 路由。
 *  - 先等待 BullMQ/Redis 就绪并执行一次 reconciler，再 listen
 *  - WS 只挂在 `/api/projects/:id/chat`，项目 ID 取自 URL；其他路径 destroy
 *  - 用 `noServer: true` 自己接管 upgrade，避免 ws 库创建第二个 http server
 */
const app = createHttpApp({
  config,
  artifacts,
  desks,
  files,
  chats,
  sessions,
  generate,
  taskStore,
  batchSubmitter,
  memory,
  bullBoard,
  metrics,
  logger,
  readiness: () => readiness.check(),
  cancelFileGc: (projectId) => fileGc.cancel(projectId),
});
const sockets = new WebSocketServer({ noServer: true });

async function start() {
  await bullmq.waitUntilReady();
  await reconciler.reconcileOnce();
  const staleRuns = await chats.interruptStaleRunsGlobal(15 * 60 * 1_000);
  metrics.observeStaleRuns(staleRuns);
  if (staleRuns > 0) logger.warn("agent_stale_runs_interrupted", { count: staleRuns, phase: "startup" });
  // 避免重启后回放历史 terminal（会刷屏 object_changed / 误触发 job-wake）
  const eventCursor = await taskEventStore.latestId();
  wakePoller.restoreCursor([{ id: eventCursor } as never]);
  deskRefreshPoller.restoreCursor([{ id: eventCursor } as never]);

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    logger.info("server_started", { port: info.port });
  });

  // HTTP upgrade 拦截：校验项目存在后再放行 chat 通道
  server.on("upgrade", (request, socket, head) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
        const match = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/chat$/i);
        if (!match) {
          socket.destroy();
          return;
        }
        const projectId = match[1];
        const exists = await desks.projectExists(projectId);
        if (!exists) {
          socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        sockets.handleUpgrade(request, socket, head, (webSocket) => chat.connect(projectId, webSocket));
      } catch {
        socket.destroy();
      }
    })();
  });

  /** 优雅关停：先关 WS → await HTTP close → Agent 会话 → DB pool */
  async function shutdown() {
    clearInterval(dispatchTimer);
    clearInterval(reconcileTimer);
    clearInterval(wakeTimer);
    clearInterval(deskRefreshTimer);
    clearInterval(watchdogTimer);
    for (const client of sockets.clients) client.close(1001, "server shutdown");
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await sessions.shutdown();
    await bullmq.shutdown();
    traces.forceCloseAll("server shutdown");
    await traces.flush();
    fileGc.cancelAll();
    await pool.end();
  }
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

void start().catch((error) => {
  logger.error("server_start_failed", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
