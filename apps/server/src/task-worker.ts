/**
 * 独立 BullMQ Worker 进程（无 HTTP）。
 * 与 API（`index.ts`）分离：API 只受理任务 + outbox 投递；本进程执行 image.generate / artifact.name。
 * 本地：`npm run dev:worker`；可水平扩展多实例。
 */
import { ArtifactService } from "./services/artifact-service.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db/client.js";
import { FileStorage } from "./services/file-storage.js";
import { HttpImageGenerator } from "./services/image-generator.js";
import { GenerationOperationStore } from "./tasks/generation-operation-store.js";
import { ImageTaskExecutor } from "./tasks/image-task-executor.js";
import { AssetTaskWorker } from "./tasks/bullmq/worker.js";
import { TaskStore } from "./tasks/task-store.js";
import { ArtifactNameTaskService } from "./tasks/artifact-name-task.js";
import { createAgentTracer } from "./agent/tracing/index.js";
import { RuntimeMetrics } from "./observability/metrics.js";
import { StructuredLogger } from "./observability/logger.js";
import { createMetricsServer } from "./observability/metrics-server.js";
import { WorkerRuntimeReadiness } from "./observability/worker-readiness.js";
const config = loadConfig();
const metrics = new RuntimeMetrics("qijian-worker");
const logger = new StructuredLogger("qijian-worker");
const { db, pool } = createDatabase(config);
const artifacts = new ArtifactService(db);
const files = new FileStorage(db, config);
const images = new HttpImageGenerator(config, files);
// 生图执行：调图像 API + append 版本（与面板/Agent 共用领域服务）
const executor = new ImageTaskExecutor(files, images, artifacts);
const taskStore = new TaskStore(db);
// 命名：图像成功后由 worker 再 submit/handle 软任务
const names = new ArtifactNameTaskService(taskStore, artifacts, config);
const tracer = createAgentTracer(config, {
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
const worker = new AssetTaskWorker(
  config,
  taskStore,
  new GenerationOperationStore(db),
  executor,
  names,
  (error) => logger.warn("bullmq_worker_error", { error: error.message }),
  tracer,
  metrics,
  logger,
);

const readiness = new WorkerRuntimeReadiness(pool, {
  pingRedis: () => worker.pingRedis(),
  isRunning: () => worker.worker.isRunning(),
}, metrics);
const metricsServer = createMetricsServer(metrics, () => readiness.check());
metricsServer.listen(config.workerMetricsPort, () => {
  logger.info("worker_started", {
    concurrency: config.taskWorkerConcurrency,
    metrics_port: config.workerMetricsPort,
  });
});

async function shutdown() {
  await new Promise<void>((resolve) => metricsServer.close(() => resolve()));
  await worker.close();
  await tracer.flush();
  await pool.end();
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
