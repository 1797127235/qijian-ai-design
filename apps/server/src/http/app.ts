import { basename } from "node:path";
import { cors } from "hono/cors";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { ServerConfig } from "../config.js";
import type { Database } from "../db/client.js";
import { storedFiles } from "../db/schema.js";
import { artifactTypes } from "../domain/types.js";
import { HttpError } from "../lib/errors.js";
import type { ArtifactService } from "../services/artifact-service.js";
import type { DeskStateService } from "../services/desk-state-service.js";
import type { ExportService } from "../services/export-service.js";
import type { FileStorage } from "../services/file-storage.js";
import type { ChatService } from "../services/chat-service.js";
import type { AgentSessionRegistry } from "../agent/session-registry.js";

interface HttpDependencies {
  config: ServerConfig;
  db: Database;
  artifacts: ArtifactService;
  desks: DeskStateService;
  files: FileStorage;
  exports: ExportService;
  chats: ChatService;
  sessions: AgentSessionRegistry;
}

const artifactTypeSchema = z.enum(artifactTypes);
const versionSchema = z.object({
  payload: z.record(z.string(), z.unknown()),
  inputRefs: z.array(z.unknown()).optional(),
  status: z.enum(["draft", "confirmed"]).optional(),
  createdBy: z.enum(["designer", "agent"]).default("designer"),
  changeReason: z.string().max(500).optional(),
});

async function body<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) throw new HttpError(422, parsed.error.issues.map((issue) => issue.message).join("; "));
  return parsed.data;
}

export function createHttpApp(deps: HttpDependencies) {
  const app = new Hono();
  app.use(logger());
  app.use(secureHeaders({ crossOriginResourcePolicy: "cross-origin", xFrameOptions: false }));
  app.use("/api/*", cors({ origin: deps.config.corsOrigins, credentials: true }));

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/api/projects", async (c) => c.json(await deps.desks.listProjects()));

  app.post("/api/projects", async (c) => {
    const input = await body(c.req.raw, z.object({ name: z.string().trim().min(1).max(200).optional() }));
    return c.json(await deps.desks.createProject(input.name ?? "未命名项目"), 201);
  });

  app.delete("/api/projects/:id", async (c) => {
    const projectId = c.req.param("id");
    await deps.sessions.forgetProject(projectId);
    const result = await deps.desks.deleteProject(projectId);
    await deps.files.removeProjectFiles(projectId, result.objectKeys);
    return c.body(null, 204);
  });

  app.get("/api/projects/:id/desk", async (c) => c.json(await deps.desks.snapshot(c.req.param("id"))));

  app.get("/api/projects/:id/chat/threads", async (c) => c.json(await deps.chats.listThreads(c.req.param("id"))));

  app.post("/api/projects/:id/chat/threads", async (c) => c.json(await deps.chats.createThread(c.req.param("id")), 201));

  app.delete("/api/projects/:id/chat/threads/:threadId", async (c) => {
    const projectId = c.req.param("id");
    const threadId = c.req.param("threadId");
    await deps.sessions.forget(projectId, threadId);
    await deps.chats.deleteThread(projectId, threadId);
    return c.body(null, 204);
  });

  app.get("/api/projects/:id/chat/messages", async (c) => c.json(await deps.chats.history(
    c.req.param("id"),
    c.req.query("threadId") || undefined,
  )));

  app.patch("/api/projects/:id/desk", async (c) => {
    const input = await body(c.req.raw, z.object({ viewport: z.object({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().min(0.1).max(4) }) }));
    return c.json({ viewport: await deps.desks.setViewport(c.req.param("id"), input.viewport) });
  });

  app.patch("/api/projects/:id/desk/objects/:artifactId", async (c) => {
    const patch = await body(c.req.raw, z.object({ x: z.number().finite().optional(), y: z.number().finite().optional(), rot: z.number().finite().optional(), w: z.number().positive().optional() }).refine((value) => Object.keys(value).length > 0));
    return c.json(await deps.desks.moveObject(c.req.param("id"), c.req.param("artifactId"), patch));
  });

  app.post("/api/projects/:id/artifacts", async (c) => {
    const input = await body(c.req.raw, z.object({ artifactType: artifactTypeSchema, ...versionSchema.shape, layout: z.object({ kind: z.string(), x: z.number(), y: z.number(), rot: z.number().default(0), w: z.number().optional() }).optional() }));
    const result = await deps.artifacts.create(c.req.param("id"), input.artifactType, input);
    if (input.layout) await deps.desks.placeObject(c.req.param("id"), { artifact_id: result.artifact.id, ...input.layout });
    return c.json(result, 201);
  });

  app.post("/api/artifacts/:id/versions", async (c) => {
    const input = await body(c.req.raw, versionSchema);
    return c.json(await deps.artifacts.append(c.req.param("id"), input), 201);
  });

  app.post("/api/artifacts/:id/confirm", async (c) => c.json(await deps.artifacts.confirm(c.req.param("id"), "designer")));

  app.post("/api/artifacts/:id/rollback", async (c) => {
    const input = await body(c.req.raw, z.object({ versionId: z.string().uuid().optional() }));
    return c.json(await deps.artifacts.rollback(c.req.param("id"), input.versionId));
  });

  app.post("/api/projects/:id/files", async (c) => {
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new HttpError(422, "请在 file 字段上传文件");
    const allowed = new Set(["application/pdf", "image/jpeg", "image/png"]);
    if (!allowed.has(file.type)) throw new HttpError(422, "仅支持 PDF、JPG 和 PNG");
    if (file.size > 30 * 1024 * 1024) throw new HttpError(422, "单个文件不能超过 30MB");
    return c.json(await deps.files.put(c.req.param("id"), basename(file.name), file.type, new Uint8Array(await file.arrayBuffer())), 201);
  });

  app.get("/api/files/:id", async (c) => {
    const [stored] = await deps.db.select().from(storedFiles).where(eq(storedFiles.id, c.req.param("id")));
    if (!stored) throw new HttpError(404, "文件不存在");
    const bytes = await deps.files.read(stored.objectKey);
    return new Response(bytes, { headers: { "content-type": stored.mediaType, "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(stored.originalFilename)}`, "cross-origin-resource-policy": "cross-origin" } });
  });

  app.post("/api/projects/:id/export", async (c) => c.json(await deps.exports.export(c.req.param("id")), 201));

  app.notFound((c) => c.json({ error: "接口不存在" }, 404));
  app.onError((error, c) => {
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500) console.error(error);
    return c.json({ error: error instanceof Error ? error.message : "服务器错误" }, status);
  });
  return app;
}
