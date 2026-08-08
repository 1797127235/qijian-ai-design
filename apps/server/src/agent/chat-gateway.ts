/**
 * WebSocket 聊天网关：项目维度 fan-out 事件 + 接收 prompt/stop 消息。
 *
 *  - 收到 prompt：解析 → 解析 thread → appendPrompt（写 user_message + 启 run）→ sessions.prompt（喂模型）
 *  - 收到 stop：sessions.stop + finishRunningRuns
 *  - 工具结果判定：sessions.prompt 完成后调 summarizeRunTools，按 run 内是否有 failed 工具决定 run 终态
 *  - 任何 error 包成 ServerErrorPayload 回 socket（不影响其他连接）
 */
import type { WebSocket } from "ws";
import { z } from "zod";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "../domain/attachment-limits.js";
import { MAX_SELECTED_ARTIFACTS } from "../domain/selection-limits.js";
import { AppError } from "../lib/errors.js";
import type { ChatService } from "../services/chat-service.js";
import type { ProjectAutoNamer } from "../services/project-namer.js";
import type { EventSink, ServerEvent } from "./events.js";
import type { AgentSessionRegistry } from "./session-registry.js";
import type { TraceRegistry } from "./tracing/index.js";
import { mapErrorFromUnknown, truncateText } from "./tracing/index.js";

/** 客户端消息 schema：prompt / stop 两类。 */
const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("prompt"),
    text: z.string().max(20_000).default(""),
    threadId: z.string().min(1).optional(),
    clientMessageId: z.string().min(1).max(200).optional(),
    attachmentIds: z.array(z.string().min(1)).max(MAX_ATTACHMENTS_PER_MESSAGE).default([]),
    // 方案 1：选中随本条 prompt 携带；max 对齐框选多选上限
    selectedArtifactIds: z.array(z.string().min(1)).max(MAX_SELECTED_ARTIFACTS).default([]),
  }).refine((message) => message.text.trim().length > 0 || message.attachmentIds.length > 0, {
    // 仅选中不算可发送内容，避免空聊；有字或附件才进模型
    message: "消息或附件至少需要一项",
  }),
  z.object({ type: z.literal("stop"), threadId: z.string().min(1) }),
]);

/**
 * ChatGateway：WS 事件总线。
 *  - clients: projectId → 连接的 WebSocket 集合（同一项目多 tab 都能收到事件）
 *  - stopping: 标记正在 stop 中的 thread，避免 stop 流程与 sessions.prompt 错乱标 failed
 */
export class ChatGateway {
  private readonly clients = new Map<string, Set<WebSocket>>();
  private readonly stopping = new Set<string>();
  readonly emit: EventSink = (event) => this.broadcastEvent(event);

  /** 自动起名器（index.ts 在 publish 回填后注入，打破循环依赖） */
  namer?: ProjectAutoNamer;

  constructor(
    private readonly sessions: AgentSessionRegistry,
    private readonly chats: ChatService,
    private readonly traces?: TraceRegistry,
  ) {}

  /** 新连接：登记到对应 project 的连接组 + 推一条 connected 事件。 */
  connect(projectId: string, socket: WebSocket) {
    const group = this.clients.get(projectId) ?? new Set<WebSocket>();
    group.add(socket);
    this.clients.set(projectId, group);
    this.send(socket, { type: "agent_event", event: { type: "connected", projectId } });
    socket.on("message", (raw) => void this.receive(projectId, socket, raw.toString()));
    socket.on("close", () => {
      group.delete(socket);
      if (group.size === 0) this.clients.delete(projectId);
    });
  }

  private async receive(projectId: string, socket: WebSocket, raw: string) {
    let clientMessageId: string | undefined;
    try {
      const decoded = JSON.parse(raw) as unknown;
      if (decoded && typeof decoded === "object" && typeof (decoded as { clientMessageId?: unknown }).clientMessageId === "string") {
        clientMessageId = (decoded as { clientMessageId: string }).clientMessageId;
      }
      const message = clientMessageSchema.parse(decoded);
      if (message.type === "stop") {
        const thread = await this.chats.resolveThread(projectId, message.threadId);
        const key = `${projectId}:${thread.id}`;
        this.stopping.add(key);
        try {
          const stopped = await this.sessions.stop(projectId, thread.id);
          if (stopped) {
            for (const statusMessage of await this.chats.finishRunningRuns(projectId, thread.id, "stopped")) {
              this.emit({ type: "chat_message", projectId, message: statusMessage });
            }
          }
          this.emit({ type: "agent_stopped", projectId, threadId: thread.id, stopped });
        } finally {
          this.stopping.delete(key);
        }
        return;
      }
      if (message.type !== "prompt") throw new Error("无效的聊天消息");
      const thread = await this.chats.resolveThread(projectId, message.threadId);
      // ensure：保证 session 存在（懒加载）；不 await prompt，prompt 是「等 AI 出结果」的长过程
      await this.sessions.ensure(projectId, thread.id);
      const saved = await this.chats.appendPrompt(
        projectId,
        thread.id,
        message.text,
        message.clientMessageId ? `client:${projectId}:${message.clientMessageId}` : undefined,
        message.attachmentIds,
      );
      // 收到就回 ack：让前端能立刻渲染用户消息，不必等 AI
      this.send(socket, {
        type: "prompt_ack",
        projectId,
        threadId: thread.id,
        clientMessageId: message.clientMessageId,
        message: saved.message,
      });
      this.emit({ type: "chat_message", projectId, message: saved.message });
      if (saved.created) this.namer?.kick(projectId, message.text);
      if (saved.created && saved.run) {
        const runId = saved.run.id;
        // H7：捕获 run_id 常量；root 生命周期可晚于 H2 finish
        if (this.traces?.enabled) {
          const textCap = truncateText(saved.message.text ?? "");
          const ctx = this.traces.startRoot({
            project_id: projectId,
            thread_id: thread.id,
            run_id: runId,
            client_message_id: message.clientMessageId,
            inputs: { text: textCap.text, truncated: textCap.truncated || undefined },
          });
          void this.chats.setSmithRunId(runId, ctx.smithRunId).catch((err) => {
            console.warn("[langsmith] setSmithRunId failed:", err instanceof Error ? err.message : err);
          });
        }
        try {
          // appendPrompt 只落用户原文；selected 与状态栏仅进当轮 session.prompt（KV cache 友好）
          await this.sessions.prompt(
            projectId,
            thread.id,
            saved.message.text,
            saved.message.attachments,
            runId,
            message.selectedArtifactIds,
          );
        } catch (error) {
          // stop 流程中抛错也按 stopped 处理（不是失败，是用户主动停的）
          const errorMessage = error instanceof Error ? error.message : "聊天处理失败";
          const status = this.stopping.has(`${projectId}:${thread.id}`) ? "stopped" : "failed";
          const statusMessage = await this.chats.finishRun(runId, status, status === "failed" ? errorMessage : undefined);
          if (statusMessage) this.emit({ type: "chat_message", projectId, message: statusMessage });
          else if (status === "failed") this.sendError(socket, error);
          const mapped = mapErrorFromUnknown(error, {
            aborted: status === "stopped",
          });
          this.traces?.markProductFinished(runId, {
            status: "error",
            error: mapped,
            outputs: { run_status: status },
          });
          return;
        }
        // H2：loop 跑完 ≠ 业务成功；按本 run 工具结果收口
        const outcome = await this.chats.summarizeRunTools(runId);
        const statusMessage = await this.chats.finishRun(runId, outcome.status, outcome.error);
        if (statusMessage) this.emit({ type: "chat_message", projectId, message: statusMessage });
        this.traces?.markProductFinished(runId, {
          status: outcome.status === "failed" ? "error" : "ok",
          error: outcome.status === "failed"
            ? mapErrorFromUnknown(outcome.error ?? "任务失败")
            : undefined,
          outputs: { run_status: outcome.status },
        });
      }
    } catch (error) {
      this.sendError(socket, error, clientMessageId);
    }
  }

  private broadcastEvent(event: ServerEvent) {
    const projectId = event.type === "agent_event"
      ? (event.event as { projectId?: string }).projectId
      : "projectId" in event ? event.projectId : undefined;
    if (!projectId) return;
    for (const socket of this.clients.get(projectId) ?? []) this.send(socket, event);
  }

  private send(socket: WebSocket, event: ServerEvent) {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
  }

  private sendError(socket: WebSocket, error: unknown, clientMessageId?: string) {
    const appError = error instanceof AppError
      ? error
      : error instanceof z.ZodError
        ? new AppError(
            422,
            "VALIDATION_FAILED",
            error.issues[0]?.message ?? "聊天消息格式无效",
            false,
            error.issues,
          )
      : new AppError(500, "INTERNAL_ERROR", error instanceof Error ? error.message : "聊天处理失败", true);
    this.send(socket, {
      type: "error",
      clientMessageId,
      error: {
        code: appError.code,
        message: appError.message,
        retryable: appError.retryable,
        details: appError.details,
      },
    });
  }
}
