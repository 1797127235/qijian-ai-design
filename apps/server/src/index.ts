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
import { AgentJobRunner } from "./agent/async-job/runner.js";
import { AgentJobStore } from "./agent/async-job/store.js";
import { ChatGateway } from "./agent/chat-gateway.js";
import type { EventSink } from "./agent/events.js";
import { AgentSessionRegistry } from "./agent/session-registry.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db/client.js";
import { createHttpApp } from "./http/app.js";
import { ArtifactService } from "./services/artifact-service.js";
import { CanvasGenerateService } from "./services/canvas-generate-service.js";
import { DeskStateService } from "./services/desk-state-service.js";
import { FileStorage } from "./services/file-storage.js";
import { HttpImageGenerator } from "./services/image-generator.js";
import { ChatService } from "./services/chat-service.js";
import { createTraceRegistry } from "./agent/tracing/index.js";

// —— 基础设施 ——
const config = loadConfig();
const { db, pool } = createDatabase(config);

// —— 领域服务（单实体）——
const artifacts = new ArtifactService(db);
const desks = new DeskStateService(db);
const files = new FileStorage(db, config);
const effects = new HttpImageGenerator(config, files);
const chats = new ChatService(db);

// —— 复合服务：Agent 写桌唯一通路（generate_from_desk）——
// 拼装 artifacts+desks+files+effects 四个原子服务，让 Agent 一次调用就能落桌
const generate = new CanvasGenerateService(db, artifacts, desks, files, effects);
// 文件孤儿检查依赖 chats/artifacts 谁持引用，先建好服务再回填
files.setReferenceCheckers([chats, artifacts]);

// —— Agent 异步任务（job）——
// publish 先用 no-op 占位，等 ChatGateway 构造好再回填成 chat.emit
let publish: EventSink = () => undefined;
const traces = createTraceRegistry(config);
const jobStore = new AgentJobStore(db);
const jobs = new AgentJobRunner(jobStore, (event) => publish(event), traces);
// 启动时把上次崩溃遗留的 running job 标记为 interrupted，避免「幽灵生成」
void jobs.interruptStaleOnBoot()
  .then((n) => {
    if (n > 0) console.log(`Interrupted ${n} stale agent job(s) on boot`);
  })
  .catch((error) => {
    console.warn("Failed to interrupt stale agent jobs on boot:", error instanceof Error ? error.message : error);
  });
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
  traces,
  emit: (event) => publish(event),
});
const chat = new ChatGateway(sessions, chats, traces);
// publish 回填：从此刻起，Agent/Job 抛出的事件统一进 ChatGateway，由它按连接 fan-out
publish = chat.emit;

/**
 * HTTP 启动 + WS upgrade 路由。
 *  - WS 只挂在 `/api/projects/:id/chat`，项目 ID 取自 URL；其他路径 destroy
 *  - 用 `noServer: true` 自己接管 upgrade，避免 ws 库创建第二个 http server
 */
const app = createHttpApp({ config, artifacts, desks, files, chats, sessions, generate, jobs });
const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Qijian agent server listening on http://localhost:${info.port}`);
});
const sockets = new WebSocketServer({ noServer: true });

// HTTP upgrade 拦截：只放行 chat 通道，匹配项目 UUID
server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const match = url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/chat$/i);
  if (!match) return socket.destroy();
  sockets.handleUpgrade(request, socket, head, (webSocket) => chat.connect(match[1], webSocket));
});

/** 优雅关停：先关 WS（避免写入到关闭的连接）→ HTTP server → Agent 会话 → DB pool */
async function shutdown() {
  for (const socket of sockets.clients) socket.close(1001, "server shutdown");
  sockets.close();
  server.close();
  await sessions.shutdown();
  traces.forceCloseAll("server shutdown");
  await traces.flush();
  await pool.end();
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
