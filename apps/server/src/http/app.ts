/**
 * Hono 应用工厂。
 *  - 中间件：logger / secureHeaders（CORS 资源策略 cross-origin 允许 /api/files 给前端图）/ api CORS
 *  - 路由按实体拆：projects / desk / chat / artifacts / files
 *  - 统一错误：AppError → JSON {code, message, retryable, details}；其他 → 500 INTERNAL_ERROR
 */
import { cors } from "hono/cors";
import { Hono, type Context, type Next } from "hono";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { timingSafeEqual } from "node:crypto";
import type { ServerConfig } from "../config.js";
import { AppError } from "../lib/errors.js";
import type { ArtifactService } from "../services/artifact-service.js";
import type { CanvasGenerateService } from "../services/canvas-generate-service.js";
import type { DeskStateService } from "../services/desk-state-service.js";
import type { FileStorage } from "../services/file-storage.js";
import type { ChatService } from "../services/chat-service.js";
import type { AgentSessionRegistry } from "../agent/session-registry.js";
import type { TaskStore } from "../tasks/task-store.js";
import type { AssetBatchSubmissionService } from "../tasks/asset-batch-submission.js";
import { registerArtifactRoutes } from "./routes/artifacts.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerDeskRoutes } from "./routes/desk.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerProjectRoutes } from "./routes/projects.js";

/** HTTP 层依赖：所有 service 单例 + 路由需要用到的 service 子集。 */
interface HttpDependencies {
  config: ServerConfig;
  artifacts: ArtifactService;
  desks: DeskStateService;
  files: FileStorage;
  chats: ChatService;
  sessions: AgentSessionRegistry;
  /** 面板生图：CanvasGenerate + 持久任务队列 */
  generate?: CanvasGenerateService;
  taskStore?: TaskStore;
  batchSubmitter?: AssetBatchSubmissionService;
  bullBoard?: Hono;
}

function hasBullBoardCredentials(c: Context, expectedUsername: string, expectedPassword: string): boolean {
  const authorization = c.req.header("authorization") ?? "";
  if (!authorization.startsWith("Basic ")) return false;
  let supplied = "";
  try {
    supplied = Buffer.from(authorization.slice(6).trim(), "base64").toString("utf8");
  } catch {
    return false;
  }
  const expectedBytes = Buffer.from(`${expectedUsername}:${expectedPassword}`);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length
    && timingSafeEqual(expectedBytes, suppliedBytes);
}

async function protectBullBoard(c: Context, next: Next, username?: string, password?: string) {
  if (!username || !password || hasBullBoardCredentials(c, username, password)) return next();
  c.header("WWW-Authenticate", "Basic realm=\"Bull Board\", charset=\"UTF-8\"");
  return c.text("Bull Board credentials required", 401);
}

export function createHttpApp(deps: HttpDependencies) {
  const app = new Hono();
  app.use(logger());
  // 允许前端从另一个 origin 加载 /api/files 的图片：cross-origin
  app.use(secureHeaders({ crossOriginResourcePolicy: "cross-origin", xFrameOptions: false }));
  // /api/* 才走 CORS：避免污染 /health
  app.use("/api/*", cors({ origin: deps.config.corsOrigins, credentials: true }));

  // 健康检查：livenessProbe 用
  app.get("/health", (c) => c.json({ ok: true }));

  // 前端公开配置（无密钥）：生图模型列表（含所属 provider 标签）
  app.get("/api/public-config", (c) =>
    c.json({
      imageModel: deps.config.imageModel ?? null,
      imageModels: deps.config.imageModelOptions,
      imageModelChoices: deps.config.imageModelChoices,
      imageSize: deps.config.imageSize ?? null,
    }),
  );

  if (deps.bullBoard) {
    const boardPath = deps.config.bullBoardPath;
    const authenticate = (c: Context, next: Next) => protectBullBoard(
      c,
      next,
      deps.config.bullBoardUsername,
      deps.config.bullBoardPassword,
    );
    app.use(boardPath, authenticate);
    app.use(`${boardPath}/*`, authenticate);
    app.get(`${boardPath}/`, (c) => c.redirect(boardPath, 308));
    app.route(boardPath, deps.bullBoard);
  }

  // 路由注册：每个文件管自己的资源
  registerProjectRoutes(app, deps);
  registerDeskRoutes(app, {
    desks: deps.desks,
    artifacts: deps.artifacts,
    generate: deps.generate,
    taskStore: deps.taskStore,
    defaultImageModel: deps.config.imageModel,
    batchSubmitter: deps.batchSubmitter,
  });
  registerChatRoutes(app, deps);
  registerArtifactRoutes(app, deps);
  registerFileRoutes(app, deps);

  // 404 / 500 都走 AppError 形态
  app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "接口不存在", retryable: false } }, 404));
  app.onError((error, c) => {
    const status = error instanceof AppError ? error.status : 500;
    if (status === 500) console.error(error);
    const payload = error instanceof AppError
      ? { code: error.code, message: error.message, retryable: error.retryable, details: error.details }
      : { code: "INTERNAL_ERROR", message: "服务器错误", retryable: true };
    return c.json({ error: payload }, status);
  });
  return app;
}
