import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { agentSessionDir } from "./session-paths.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot() {
  const dir = await mkdtemp(join(tmpdir(), "qijian-agent-session-"));
  tempDirs.push(dir);
  return dir;
}

describe("pi session persistence (H1)", () => {
  it("continueRecent restores toolCall + toolResult after process-like reopen", async () => {
    const root = await tempRoot();
    const sessionDir = agentSessionDir("project-a", "thread-b", root);
    const cwd = process.cwd();

    const writer = SessionManager.continueRecent(cwd, sessionDir);
    writer.appendMessage({
      role: "user",
      content: "改成日式暖色",
      timestamp: Date.now(),
    });
    writer.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "正在生成" },
        {
          type: "toolCall",
          id: "call-1",
          name: "generate_from_desk",
          arguments: { prompt: "日式暖色", source_artifact_id: "src-1" },
        },
      ],
      api: "openai-responses",
      provider: "test",
      model: "test-model",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: Date.now(),
    });
    writer.appendMessage({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "generate_from_desk",
      content: [{ type: "text", text: "status=ready artifact_id=art-9" }],
      details: { ok: true, artifact_id: "art-9", status: "ready" },
      isError: false,
      timestamp: Date.now(),
    });
    writer.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "已落桌 art-9" }],
      api: "openai-responses",
      provider: "test",
      model: "test-model",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });

    expect(writer.isPersisted()).toBe(true);
    expect(writer.getSessionFile()).toBeTruthy();

    // 模拟进程退出后重新打开：新 SessionManager，同 sessionDir
    const reader = SessionManager.continueRecent(cwd, sessionDir);
    const messages = reader.buildSessionContext().messages;
    const roles = messages.map((message) => message.role);

    expect(roles).toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect(messages[2]).toMatchObject({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "generate_from_desk",
      isError: false,
    });
    expect(JSON.stringify(messages[2])).toContain("art-9");
  });

  it("isolates sessions by project and thread directories", async () => {
    const root = await tempRoot();
    const cwd = process.cwd();
    const a = SessionManager.continueRecent(cwd, agentSessionDir("p1", "t1", root));
    const b = SessionManager.continueRecent(cwd, agentSessionDir("p1", "t2", root));
    // pi 在出现 assistant 之前不落盘；隔离测需要完整一轮
    const assistant = (text: string) => ({
      role: "assistant" as const,
      content: [{ type: "text" as const, text }],
      api: "openai-responses",
      provider: "test",
      model: "test-model",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop" as const,
      timestamp: Date.now(),
    });

    a.appendMessage({ role: "user", content: "thread-1 only", timestamp: Date.now() });
    a.appendMessage(assistant("ok-1"));
    b.appendMessage({ role: "user", content: "thread-2 only", timestamp: Date.now() });
    b.appendMessage(assistant("ok-2"));

    const a2 = SessionManager.continueRecent(cwd, agentSessionDir("p1", "t1", root));
    const b2 = SessionManager.continueRecent(cwd, agentSessionDir("p1", "t2", root));

    expect(a2.buildSessionContext().messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(a2.buildSessionContext().messages[0]).toMatchObject({ content: "thread-1 only" });
    expect(b2.buildSessionContext().messages[0]).toMatchObject({ content: "thread-2 only" });
  });
});
