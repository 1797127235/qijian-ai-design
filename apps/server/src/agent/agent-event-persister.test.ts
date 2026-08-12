import { describe, expect, it, vi } from "vitest";
import { persistToolEvent } from "./agent-event-persister.js";

describe("persistToolEvent observation", () => {
  it("stores the model turn and argument size on tool start", async () => {
    const chats = {
      startToolCall: vi.fn().mockResolvedValue(undefined),
      finishToolCall: vi.fn(),
    };

    await persistToolEvent(chats as never, "run-1", {
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "look_at_desk",
      args: { prompt: "inspect the desk" },
    }, { turnIndex: 2, promptTokensBefore: 1_200 });

    expect(chats.startToolCall).toHaveBeenCalledWith(
      "run-1",
      "call-1",
      "look_at_desk",
      { prompt: "inspect the desk" },
      expect.objectContaining({
        turnIndex: 2,
        argumentCharacters: expect.any(Number),
        argumentBytes: expect.any(Number),
        promptTokensBefore: 1_200,
      }),
    );
  });

  it("stores result size without collecting monetary cost", async () => {
    const chats = {
      startToolCall: vi.fn(),
      finishToolCall: vi.fn().mockResolvedValue(undefined),
    };
    const result = {
      content: [{ type: "text", text: "done" }],
      details: { ok: true, cost: { total: 99 } },
    };

    await persistToolEvent(chats as never, "run-1", {
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "look_at_desk",
      result,
      isError: false,
    }, { turnIndex: 2, promptTokensBefore: 1_200 });

    expect(chats.finishToolCall).toHaveBeenCalledWith(
      "run-1",
      "call-1",
      "look_at_desk",
      result,
      false,
      undefined,
      expect.objectContaining({
        turnIndex: 2,
        resultCharacters: expect.any(Number),
        resultBytes: expect.any(Number),
        promptTokensBefore: 1_200,
      }),
    );
    expect(chats.finishToolCall.mock.calls[0]).not.toContainEqual({ total: 99 });
  });
});
