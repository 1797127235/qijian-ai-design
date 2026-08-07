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
  it("reports schema violations as non-retryable validation errors", async () => {
    const sessions = { ensure: vi.fn(), prompt: vi.fn() };
    const chats = { resolveThread: vi.fn(), appendPrompt: vi.fn() };
    const gateway = new ChatGateway(sessions as never, chats as never);
    const client = socket();

    await receive(gateway, client, { type: "prompt", text: "", clientMessageId: "draft-invalid", attachmentIds: [] });

    expect(JSON.parse(client.send.mock.calls[0][0])).toMatchObject({
      type: "error",
      clientMessageId: "draft-invalid",
      error: { code: "VALIDATION_FAILED", retryable: false },
    });
    expect(sessions.ensure).not.toHaveBeenCalled();
    expect(chats.appendPrompt).not.toHaveBeenCalled();
  });

  it("persists a completed run around an agent prompt", async () => {
    const sessions = { ensure: vi.fn(), prompt: vi.fn().mockResolvedValue(undefined) };
    const chats = {
      resolveThread: vi.fn().mockResolvedValue({ id: "thread-1" }),
      appendPrompt: vi.fn().mockResolvedValue({
        created: true,
        message: { id: "message-1", threadId: "thread-1", projectId: "project-1", role: "user", text: "继续设计", attachments: [], createdAt: "now" },
        run: { id: "run-1" },
      }),
      summarizeRunTools: vi.fn().mockResolvedValue({ status: "completed" }),
      finishRun: vi.fn().mockResolvedValue(undefined),
    };
    const gateway = new ChatGateway(sessions as never, chats as never);

    await receive(gateway, socket(), { type: "prompt", text: "继续设计", threadId: "thread-1" });

    expect(chats.appendPrompt).toHaveBeenCalledWith("project-1", "thread-1", "继续设计", undefined, []);
    expect(sessions.prompt).toHaveBeenCalledWith("project-1", "thread-1", "继续设计", [], "run-1", []);
    expect(chats.summarizeRunTools).toHaveBeenCalledWith("run-1");
    expect(chats.finishRun).toHaveBeenCalledWith("run-1", "completed", undefined);
  });

  it("marks the run failed when tools report business failure", async () => {
    const sessions = { ensure: vi.fn(), prompt: vi.fn().mockResolvedValue(undefined) };
    const statusMessage = {
      id: "run-status:run-1",
      threadId: "thread-1",
      projectId: "project-1",
      role: "assistant",
      text: "任务执行失败：图服务返回错误",
      createdAt: "now",
    };
    const chats = {
      resolveThread: vi.fn().mockResolvedValue({ id: "thread-1" }),
      appendPrompt: vi.fn().mockResolvedValue({
        created: true,
        message: { id: "message-1", threadId: "thread-1", projectId: "project-1", role: "user", text: "改日式", attachments: [], createdAt: "now" },
        run: { id: "run-1" },
      }),
      summarizeRunTools: vi.fn().mockResolvedValue({ status: "failed", error: "图服务返回错误" }),
      finishRun: vi.fn().mockResolvedValue(statusMessage),
    };
    const gateway = new ChatGateway(sessions as never, chats as never);
    const emit = vi.spyOn(gateway, "emit");

    await receive(gateway, socket(), { type: "prompt", text: "改日式", threadId: "thread-1" });

    expect(chats.finishRun).toHaveBeenCalledWith("run-1", "failed", "图服务返回错误");
    expect(emit).toHaveBeenCalledWith({ type: "chat_message", projectId: "project-1", message: statusMessage });
  });

  it("forwards selected artifact ids to the session prompt", async () => {
    const sessions = { ensure: vi.fn(), prompt: vi.fn().mockResolvedValue(undefined) };
    const chats = {
      resolveThread: vi.fn().mockResolvedValue({ id: "thread-1" }),
      appendPrompt: vi.fn().mockResolvedValue({
        created: true,
        message: { id: "message-1", threadId: "thread-1", projectId: "project-1", role: "user", text: "描述这张图", attachments: [], createdAt: "now" },
        run: { id: "run-1" },
      }),
      summarizeRunTools: vi.fn().mockResolvedValue({ status: "completed" }),
      finishRun: vi.fn().mockResolvedValue(undefined),
    };
    const gateway = new ChatGateway(sessions as never, chats as never);

    await receive(gateway, socket(), {
      type: "prompt",
      text: "描述这张图",
      threadId: "thread-1",
      selectedArtifactIds: ["img-1"],
    });

    expect(sessions.prompt).toHaveBeenCalledWith("project-1", "thread-1", "描述这张图", [], "run-1", ["img-1"]);
  });

  it("accepts multiple selected artifact ids (marquee multiselect)", async () => {
    const sessions = { ensure: vi.fn(), prompt: vi.fn().mockResolvedValue(undefined) };
    const chats = {
      resolveThread: vi.fn().mockResolvedValue({ id: "thread-1" }),
      appendPrompt: vi.fn().mockResolvedValue({
        created: true,
        message: { id: "message-1", threadId: "thread-1", projectId: "project-1", role: "user", text: "生成后视图", attachments: [], createdAt: "now" },
        run: { id: "run-1" },
      }),
      summarizeRunTools: vi.fn().mockResolvedValue({ status: "completed" }),
      finishRun: vi.fn().mockResolvedValue(undefined),
    };
    const gateway = new ChatGateway(sessions as never, chats as never);

    await receive(gateway, socket(), {
      type: "prompt",
      text: "生成后视图",
      threadId: "thread-1",
      selectedArtifactIds: ["fx-1", "fx-2"],
    });

    expect(sessions.prompt).toHaveBeenCalledWith(
      "project-1",
      "thread-1",
      "生成后视图",
      [],
      "run-1",
      ["fx-1", "fx-2"],
    );
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
        message: { id: "message-1", threadId: "thread-1", projectId: "project-1", role: "user", text: "继续设计", attachments: [], createdAt: "now" },
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

  it("accepts an attachment-only prompt and acknowledges the correlated draft", async () => {
    const attachments = [{
      id: "file-1",
      originalFilename: "plan.pdf",
      mediaType: "application/pdf",
      sizeBytes: 1200,
      pageCount: 2,
      position: 0,
    }];
    const sessions = { ensure: vi.fn(), prompt: vi.fn().mockResolvedValue(undefined) };
    const chats = {
      resolveThread: vi.fn().mockResolvedValue({ id: "thread-1" }),
      appendPrompt: vi.fn().mockResolvedValue({
        created: true,
        message: { id: "message-1", threadId: "thread-1", projectId: "project-1", role: "user", text: "", attachments, createdAt: "now" },
        run: { id: "run-1" },
      }),
      summarizeRunTools: vi.fn().mockResolvedValue({ status: "completed" }),
      finishRun: vi.fn().mockResolvedValue(undefined),
    };
    const gateway = new ChatGateway(sessions as never, chats as never);
    const client = socket();

    await receive(gateway, client, {
      type: "prompt",
      text: "",
      threadId: "thread-1",
      clientMessageId: "draft-1",
      attachmentIds: ["file-1"],
    });

    expect(chats.appendPrompt).toHaveBeenCalledWith(
      "project-1",
      "thread-1",
      "",
      "client:project-1:draft-1",
      ["file-1"],
    );
    expect(sessions.prompt).toHaveBeenCalledWith("project-1", "thread-1", "", attachments, "run-1", []);
    expect(client.send).toHaveBeenCalledWith(expect.stringContaining('"type":"prompt_ack"'));
  });
});
