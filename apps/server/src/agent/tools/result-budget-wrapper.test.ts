import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { ContextResourceStore } from "../context/resource-store.js";
import { createReadContextResourceTool } from "./read-context-resource.js";
import { budgetToolDefinition } from "./result-budget-wrapper.js";
import type { ToolContext } from "./shared.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function resources() {
  const root = await mkdtemp(join(tmpdir(), "qijian-result-budget-"));
  roots.push(root);
  return new ContextResourceStore(root);
}

describe("budgetToolDefinition", () => {
  it("stores oversized text before returning a bounded tool result", async () => {
    const store = await resources();
    const originalText = "完整记忆。".repeat(4_000);
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: originalText }],
      details: { ok: true, revision: 3 },
    }));
    const tool = budgetToolDefinition({
      name: "inspect_project_memory",
      label: "memory",
      description: "memory",
      parameters: Type.Object({}),
      execute,
    }, store);

    const result = await tool.execute("call-1", {}, undefined, undefined, {} as never);
    const metrics = (result.details as { result_budget: { resource_ref: string } }).result_budget;
    const chunks: string[] = [];
    let cursor: string | undefined = "0";
    do {
      const page = await store.readText(metrics.resource_ref, { cursor, maxChars: 6_000 });
      expect(page.ok).toBe(true);
      if (!page.ok) break;
      chunks.push(page.text);
      cursor = page.nextCursor;
    } while (cursor !== undefined);

    expect(execute).toHaveBeenCalledOnce();
    expect(metrics.resource_ref).toMatch(/^ctxres:sha256:/);
    expect(chunks.join("")).toBe(originalText);
  });

  it("does not write a resource for an inline result", async () => {
    const store = await resources();
    const putText = vi.spyOn(store, "putText");
    const tool = budgetToolDefinition({
      name: "get_task",
      label: "task",
      description: "task",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text" as const, text: "status=ready" }], details: { ok: true } };
      },
    }, store);

    await tool.execute("call-2", {}, undefined, undefined, {} as never);

    expect(putText).not.toHaveBeenCalled();
  });
});

describe("read_context_resource", () => {
  it("returns one bounded page and a continuation cursor", async () => {
    const store = await resources();
    const resourceRef = await store.putText("inspect_project_memory", "A".repeat(8_000));
    const tool = createReadContextResourceTool({
      resourceStore: store,
    } as unknown as ToolContext);

    const result = await tool.execute("read-1", {
      resource_ref: resourceRef,
      cursor: "0",
      max_chars: 5_000,
    }, undefined, undefined, {} as never);
    const text = result.content.map((block) => block.type === "text" ? block.text : "").join("");

    expect(text).toContain("source_tool=inspect_project_memory");
    expect(text).toContain("next_cursor=5000");
    expect(result.details).toMatchObject({
      ok: true,
      resource_ref: resourceRef,
      cursor: "0",
      next_cursor: "5000",
      total_chars: 8_000,
    });
  });
});
