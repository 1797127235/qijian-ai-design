import { cors } from "hono/cors";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import type { ServerConfig } from "../config.js";
import { AppError } from "../lib/errors.js";
import type { ArtifactService } from "../services/artifact-service.js";
import type { DeskStateService } from "../services/desk-state-service.js";
import type { ExportService } from "../services/export-service.js";
import type { FileStorage } from "../services/file-storage.js";
import type { ChatService } from "../services/chat-service.js";
import type { AgentSessionRegistry } from "../agent/session-registry.js";
import { registerArtifactRoutes } from "./routes/artifacts.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerDeskRoutes } from "./routes/desk.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerProjectRoutes } from "./routes/projects.js";

interface HttpDependencies {
  config: ServerConfig;
  artifacts: ArtifactService;
  desks: DeskStateService;
  files: FileStorage;
  exports: ExportService;
  chats: ChatService;
  sessions: AgentSessionRegistry;
}

export function createHttpApp(deps: HttpDependencies) {
  const app = new Hono();
  app.use(logger());
  app.use(secureHeaders({ crossOriginResourcePolicy: "cross-origin", xFrameOptions: false }));
  app.use("/api/*", cors({ origin: deps.config.corsOrigins, credentials: true }));

  app.get("/health", (c) => c.json({ ok: true }));

  registerProjectRoutes(app, deps);
  registerDeskRoutes(app, deps);
  registerChatRoutes(app, deps);
  registerArtifactRoutes(app, deps);
  registerFileRoutes(app, deps);

  app.post("/api/projects/:id/export", async (c) => c.json(await deps.exports.export(c.req.param("id")), 201));

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
