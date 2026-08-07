/**
 * 对话路由：thread 列表 / 创建 / 删除 / 历史。
 *  - 删 thread 必须先 forget session（释放 pi session 资源）→ 删 chat_threads 行
 *  - GET messages 不传 threadId 时取最新 thread（resolveThread 内部兜底新建）
 *  - prompt / stop 走 WebSocket，不在这里
 */
import type { Hono } from "hono";
import type { AgentSessionRegistry } from "../../agent/session-registry.js";
import type { ChatService } from "../../services/chat-service.js";

export function registerChatRoutes(
  app: Hono,
  deps: {
    chats: ChatService;
    sessions: AgentSessionRegistry;
  },
) {
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
}
