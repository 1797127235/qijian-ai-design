/**
 * 服务端入口：依赖装配 + HTTP/WS 启动。
 *
 * 装配顺序由内向外：
 *   1) 基础设施：config / db pool
 *   2) 领域服务：artifacts / desks / files / chats / image generator
 *   3) 复合服务：CanvasGenerateService（聚合 artifacts+desks+files+effects 给 Agent 调用）
 *   4) 文件引用检查器互注册：chats / artifacts 谁持有 file_id，FileStorage 才能算孤儿
 *   5) Agent 异步任务：jobStore / runner，进程启动时清扫「running 中」遗留 job
 *   6) AgentSessionRegistry：把 pi-coding-agent 实例与上述服务绑定
 *   7) ChatGateway：所有 event 统一入口，publish 函数先占位再回填避免循环依赖
 */
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { JobWakeService } from "./agent/async-job/job-wake.js";
import { AgentJobRunner } from "./agent/async-job/runner.js";
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
import { ProjectCoverService } from "./services/project-cover-service.js";
import { eq } from "drizzle-orm";
import { projects } from "./db/schema.js";

// —— 基础设施 ——
const config = loadConfig();
// 多网关 model id 冲突：先注册者生效（见 image-providers 约定）
warnDuplicateImageModels(config.imageProviders);
const { db, pool } = createDatabase(config);

// —— 领域服务（单实体）——
const artifacts = new ArtifactService(db);
const desks = new DeskStateService(db);
const files = new FileStorage(db, config);
const effects = new HttpImageGenerator(config, files);
const chats = new ChatService(db);
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
// 删物件后异步扫本项目孤儿文件（默认 minAge 1h，不伤会话 undo；失败只记日志）
artifacts.setObjectDeletedListener((projectId) => {
  void files
    .gcUnattached({ projectId })
    .then((result) => {
      if (result.deleted > 0 || result.errors > 0) {
        console.info(`[files] gc after delete project=${projectId}`, result);
      }
    })
    .catch((error) => {
      console.warn(`[files] gc after delete failed project=${projectId}:`, error instanceof Error ? error.message : error);
    });
});

// —— Agent 异步任务（job）——
const traces = createTraceRegistry(config);
const jobStore = new AgentJobStore(db);
const jobs = new AgentJobRunner(jobStore, (event) => publish(event), traces);
const captions = captionStore;
// Agent 写桌：generate_from_desk → Job 异步外壳 → CanvasGenerateService
const sessions = new AgentSessionRegistry({
  artifacts,
  desks,
  effects,
  generate,
  chats,
  files,
  config,
  jobs,
  jobStore,
  captions,
  traces,
  emit: (event) => publish(event),
});
// 方案 3 / 书中异步事件：job 终态 → 结构化 [JOB_EVENT] 回注轨迹并续跑
const jobWake = new JobWakeService(
  chats,
  async ({ projectId, threadId, text, taskId, runId, message }) => {
    // appendPrompt 已在 JobWakeService 完成（写轨迹喂模型）。
    // 不向客户端广播 chat_message：job-wake 是系统事件，不是用户气泡。
    void message;
    if (traces?.enabled) {
      traces.startRoot({
        project_id: projectId,
        thread_id: threadId,
        run_id: runId,
        inputs: { wake: true, task_id: taskId },
      });
    }
    await sessions.runJobWake({ projectId, threadId, runId, text });
  },
  (projectId, threadId) => sessions.isThreadBusy(projectId, threadId),
);
jobs.wake = jobWake;
const chat = new ChatGateway(sessions, chats, traces);
// publish 回填：从此刻起，Agent/Job 抛出的事件统一进 ChatGateway，由它按连接 fan-out
publish = chat.emit;
// 自动起名：走 publish（= chat.emit）fan-out project_renamed；需在 publish 回填后构造
const namer = new ProjectAutoNamer(desks, config, (event) => publish(event));
chat.namer = namer;

/**
 * HTTP 启动 + WS upgrade 路由。
 *  - 先 await boot 清扫，再 listen，避免 interruptStale 误杀启动后新建的 job
 *  - WS 只挂在 `/api/projects/:id/chat`，项目 ID 取自 URL；其他路径 destroy
 *  - 用 `noServer: true` 自己接管 upgrade，避免 ws 库创建第二个 http server
 */
const app = createHttpApp({ config, artifacts, desks, files, chats, sessions, generate, jobs });
const sockets = new WebSocketServer({ noServer: true });

async function start() {
  // 启动时把上次崩溃遗留的 running job 标记为 interrupted，避免「幽灵生成」
  try {
    const n = await jobs.interruptStaleOnBoot();
    if (n > 0) console.log(`Interrupted ${n} stale agent job(s) on boot`);
  } catch (error) {
    console.warn("Failed to interrupt stale agent jobs on boot:", error instanceof Error ? error.message : error);
  }

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`Qijian agent server listening on http://localhost:${info.port}`);
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
    for (const client of sockets.clients) client.close(1001, "server shutdown");
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await sessions.shutdown();
    traces.forceCloseAll("server shutdown");
    await traces.flush();
    await pool.end();
  }
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

void start().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
