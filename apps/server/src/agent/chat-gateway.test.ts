import { describe, expect, it, vi } from "vitest";
import { ChatGateway } from "./chat-gateway.js";

function socket() {
  return { OPEN: 1, readyState: 1, send: vi.fn() };
}

async function receive(gateway: ChatGateway, client: ReturnType<typeof socket>, message: object) {
  await (gateway as unknown as {
    receive(projectId: string, socket: ReturnType<typeof socket>, raw: string): Promise<void>;
  }).receive("project-1", client, JSON.stringify(message));
}

describe("ChatGateway run lifecycle", () => {
  it("persists a completed run around an agent prompt", async () => {
    const sessions = { ensure: vi.fn(), prompt: vi.fn().mockResolvedValue(undefined) };
    const chats = {
      resolveThread: vi.fn().mockResolvedValue({ id: "thread-1" }),
      appendPrompt: vi.fn().mockResolvedValue({
        created: true,
        message: { id: "message-1", threadId: "thread-1", projectId: "project-1", role: "user", text: "继续设计", createdAt: "now" },
        run: { id: "run-1" },
      }),
      finishRun: vi.fn().mockResolvedValue(undefined),
    };
    const gateway = new ChatGateway(sessions as never, chats as never);

    await receive(gateway, socket(), { type: "prompt", text: "继续设计", threadId: "thread-1" });

    expect(chats.appendPrompt).toHaveBeenCalledWith("project-1", "thread-1", "继续设计", undefined);
    expect(sessions.prompt).toHaveBeenCalledWith("project-1", "thread-1", "继续设计", "run-1");
    expect(chats.finishRun).toHaveBeenCalledWith("run-1", "completed");
  });

  it("persists a failed terminal state instead of leaving the run active", async () => {
    const sessions = { ensure: vi.fn(), prompt: vi.fn().mockRejectedValue(new Error("provider disconnected")) };
    const statusMessage = {
      id: "run-status:run-1",
      threadId: "thread-1",
      projectId: "project-1",
      role: "assistant",
      text: "任务执行失败：provider disconnected",
      createdAt: "now",
    };
    const chats = {
      resolveThread: vi.fn().mockResolvedValue({ id: "thread-1" }),
      appendPrompt: vi.fn().mockResolvedValue({
        created: true,
        message: { id: "message-1", threadId: "thread-1", projectId: "project-1", role: "user", text: "继续设计", createdAt: "now" },
        run: { id: "run-1" },
      }),
      finishRun: vi.fn().mockResolvedValue(statusMessage),
    };
    const gateway = new ChatGateway(sessions as never, chats as never);
    const client = socket();

    await receive(gateway, client, { type: "prompt", text: "继续设计", threadId: "thread-1" });

    expect(chats.finishRun).toHaveBeenCalledWith("run-1", "failed", "provider disconnected");
    expect(client.send).not.toHaveBeenCalledWith(expect.stringContaining('"type":"error"'));
  });
});
