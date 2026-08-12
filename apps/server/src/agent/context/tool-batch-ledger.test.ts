import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  MAX_TOOL_BATCH_LEDGER_CHARS,
  TOOL_BATCH_LEDGER_CUSTOM_TYPE,
  compileToolBatchLedger,
  createToolBatchLedgerExtension,
} from "./tool-batch-ledger.js";

function assistant(toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>, text?: string) {
  return {
    role: "assistant",
    content: [
      ...(text ? [{ type: "text", text }] : []),
      ...toolCalls.map((call) => ({ type: "toolCall", ...call })),
    ],
    timestamp: 1,
  };
}

function toolResult(
  toolCallId: string,
  toolName: string,
  details: Record<string, unknown>,
  text = "ok",
) {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    details,
    isError: details.ok === false,
    timestamp: 2,
  };
}

describe("ToolBatchLedger", () => {
  it("retains goals, outcomes and facts only from closed tool batches", () => {
    const compiled = compileToolBatchLedger([
      {
        role: "user",
        content: '<system_context_frame>large frame</system_context_frame>\n\n<user_request source="interactive">\n\n生成三个方向&amp;保留暖光\n\n</user_request>',
        timestamp: 0,
      },
      assistant([
        {
          id: "call-generate",
          name: "generate_from_desk",
          arguments: { source_artifact_id: "art-source", reference_artifact_ids: ["art-ref"] },
        },
        {
          id: "call-skill",
          name: "load_skill",
          arguments: { skill_id: "interior-lighting" },
        },
      ]),
      toolResult("call-skill", "load_skill", {
        ok: true,
        skill_id: "interior-lighting",
        revision: "skill-rev-7",
      }),
      toolResult("call-generate", "generate_from_desk", {
        ok: true,
        status: "accepted",
        task_id: "task-21",
        artifact_id: "art-new",
        result_budget: {
          resource_ref: `ctxres:sha256:${"a".repeat(64)}`,
        },
      }),
      assistant([], "三个方向已提交，等待任务完成后比较。"),
    ]);

    expect(compiled.snapshot.goals).toEqual(["生成三个方向&保留暖光"]);
    expect(compiled.snapshot.outcomes).toEqual(["三个方向已提交，等待任务完成后比较。"]);
    expect(compiled.snapshot.batches).toHaveLength(1);
    expect(compiled.snapshot.batches[0].calls).toEqual([
      expect.objectContaining({
        tool_name: "generate_from_desk",
        status: "accepted",
        artifact_ids: ["art-new", "art-ref", "art-source"],
        task_ids: ["task-21"],
        resource_refs: [`ctxres:sha256:${"a".repeat(64)}`],
      }),
      expect.objectContaining({
        tool_name: "load_skill",
        status: "succeeded",
        skill_ids: ["interior-lighting"],
        revisions: ["revision=skill-rev-7"],
      }),
    ]);
    expect(compiled.report).toMatchObject({
      closed_batch_count: 1,
      closed_tool_call_count: 2,
      open_tool_call_count: 0,
    });
    expect(compiled.text).toContain("[TOOL_BATCH_LEDGER version=1");
    expect(compiled.text).toContain('"task_ids":["task-21"]');
  });

  it("omits the entire batch when any tool call is still open and counts orphan results", () => {
    const compiled = compileToolBatchLedger([
      assistant([
        { id: "call-done", name: "get_task", arguments: { task_id: "task-done" } },
        { id: "call-open", name: "look_at", arguments: { artifact_ids: ["art-open"] } },
      ]),
      toolResult("call-done", "get_task", {
        ok: true,
        status: "succeeded",
        task_id: "task-done",
        artifact_id: "art-done",
      }),
      toolResult("unknown-call", "get_task", { ok: true, task_id: "task-orphan" }),
    ]);

    expect(compiled.snapshot.batches).toEqual([]);
    expect(compiled.text).not.toContain("art-done");
    expect(compiled.report).toMatchObject({
      closed_batch_count: 0,
      closed_tool_call_count: 0,
      open_tool_call_count: 1,
      orphan_tool_result_count: 1,
    });
  });

  it("checks closure against every call even when a batch exceeds the emitted call cap", () => {
    const calls = Array.from({ length: 17 }, (_, index) => ({
      id: `call-${index}`,
      name: "get_task",
      arguments: { task_id: `task-${index}` },
    }));
    const compiled = compileToolBatchLedger([
      assistant(calls),
      ...calls.slice(0, 16).map((call, index) => toolResult(
        call.id,
        call.name,
        { ok: true, status: "succeeded", task_id: `task-${index}` },
      )),
    ]);

    expect(compiled.snapshot.batches).toEqual([]);
    expect(compiled.report.open_tool_call_count).toBe(1);

    const closed = compileToolBatchLedger([
      assistant(calls),
      ...calls.map((call, index) => toolResult(
        call.id,
        call.name,
        { ok: true, status: "succeeded", task_id: `task-${index}` },
      )),
    ]);
    expect(closed.snapshot.batches[0].calls).toHaveLength(17);
  });

  it("merges the latest persisted ledger and keeps the rendered summary bounded", () => {
    const previous = compileToolBatchLedger([
      assistant([{ id: "call-old", name: "get_task", arguments: { task_id: "task-old" } }]),
      toolResult("call-old", "get_task", { ok: true, status: "succeeded", task_id: "task-old" }),
    ]).snapshot;
    const messages: unknown[] = [{
      role: "custom",
      customType: TOOL_BATCH_LEDGER_CUSTOM_TYPE,
      content: "previous ledger",
      details: { snapshot: previous },
      timestamp: 3,
    }];
    for (let index = 0; index < 80; index += 1) {
      const suffix = `${index}-${"x".repeat(140)}`;
      messages.push(
        assistant([{
          id: `call-${index}`,
          name: "get_task",
          arguments: { task_id: `task-${suffix}` },
        }]),
        toolResult(`call-${index}`, "get_task", {
          ok: true,
          status: "succeeded",
          task_id: `task-${suffix}`,
          artifact_id: `artifact-${suffix}`,
        }),
      );
    }

    const compiled = compileToolBatchLedger(messages);

    expect(compiled.snapshot.sequence).toBeGreaterThan(previous.sequence);
    expect(compiled.snapshot.batches.at(-1)?.calls[0].task_ids[0]).toMatch(/^task-79-x+$/);
    expect(compiled.text.length).toBeLessThanOrEqual(MAX_TOOL_BATCH_LEDGER_CHARS);
    expect(compiled.report.dropped_batch_count).toBeGreaterThan(0);
  });

  it("ignores a malformed persisted snapshot and still compiles current closed batches", () => {
    const compiled = compileToolBatchLedger([
      {
        role: "custom",
        customType: TOOL_BATCH_LEDGER_CUSTOM_TYPE,
        content: "corrupt ledger",
        details: {
          snapshot: {
            schema_version: 1,
            sequence: 99,
            goals: [],
            outcomes: [],
            batches: [{ sequence: 99, calls: "not-an-array" }],
          },
        },
      },
      assistant([{ id: "call-current", name: "get_task", arguments: { task_id: "task-current" } }]),
      toolResult("call-current", "get_task", { ok: true, status: "succeeded", task_id: "task-current" }),
    ]);

    expect(compiled.snapshot.sequence).toBe(1);
    expect(compiled.snapshot.batches).toHaveLength(1);
    expect(compiled.text).toContain('"task_ids":["task-current"]');
  });

  it("injects the prepared ledger as a hidden persistent message after successful compaction", () => {
    const handlers = new Map<string, (event: any, ctx: any) => unknown>();
    const sendMessage = vi.fn();
    const onCompacted = vi.fn();
    const pi = {
      on: (event: string, handler: (value: any, ctx: any) => unknown) => handlers.set(event, handler),
      sendMessage,
    } as unknown as ExtensionAPI;
    createToolBatchLedgerExtension({ onCompacted })(pi);
    const sourceMessages = [
      assistant([{ id: "call-1", name: "get_task", arguments: { task_id: "task-1" } }]),
      toolResult("call-1", "get_task", { ok: true, status: "succeeded", task_id: "task-1" }),
    ];

    handlers.get("session_before_compact")?.({
      preparation: {
        messagesToSummarize: sourceMessages,
        turnPrefixMessages: [],
      },
    }, {});
    handlers.get("session_compact")?.({ compactionEntry: { id: "compact-1" } }, {});

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: TOOL_BATCH_LEDGER_CUSTOM_TYPE,
        display: false,
        content: expect.stringContaining('"task_ids":["task-1"]'),
        details: expect.objectContaining({
          snapshot: expect.objectContaining({ schema_version: 1 }),
          report: expect.objectContaining({ closed_tool_call_count: 1 }),
        }),
      }),
      { triggerTurn: false },
    );
    expect(onCompacted).toHaveBeenCalledWith(expect.objectContaining({ closed_batch_count: 1 }));
  });
});
