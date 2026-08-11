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
const config = loadConfig();
const { db, pool } = createDatabase(config);
const artifacts = new ArtifactService(db);
const files = new FileStorage(db, config);
const images = new HttpImageGenerator(config, files);
// 生图执行：调图像 API + append 版本（与面板/Agent 共用领域服务）
const executor = new ImageTaskExecutor(files, images, artifacts);
const taskStore = new TaskStore(db);
// 命名：图像成功后由 worker 再 submit/handle 软任务
const names = new ArtifactNameTaskService(taskStore, artifacts, config);
const worker = new AssetTaskWorker(
  config,
  taskStore,
  new GenerationOperationStore(db),
  executor,
  names,
  (error) => console.warn("[task-worker] BullMQ error:", error.message),
);

console.log(`Asset task worker started (concurrency=${config.taskWorkerConcurrency})`);

async function shutdown() {
  await worker.close();
  await pool.end();
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
