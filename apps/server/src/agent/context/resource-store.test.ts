import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextResourceStore } from "./resource-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function store() {
  const root = await mkdtemp(join(tmpdir(), "qijian-context-resources-"));
  roots.push(root);
  return new ContextResourceStore(root);
}

describe("ContextResourceStore", () => {
  it("deduplicates immutable text by content hash", async () => {
    const resources = await store();

    const first = await resources.putText("inspect_project_memory", "一二三四五六七八九十");
    const second = await resources.putText("inspect_project_memory", "一二三四五六七八九十");

    expect(first).toBe(second);
    expect(first).toMatch(/^ctxres:sha256:[0-9a-f]{64}$/);
  });

  it("reads bounded pages with a deterministic next cursor", async () => {
    const resources = await store();
    const ref = await resources.putText("search_project_memory", "ABCDEFGHIJKL");

    const first = await resources.readText(ref, { cursor: "0", maxChars: 5 });
    const second = await resources.readText(ref, { cursor: first.ok ? first.nextCursor : undefined, maxChars: 5 });

    expect(first).toEqual({
      ok: true,
      toolName: "search_project_memory",
      text: "ABCDE",
      cursor: "0",
      nextCursor: "5",
      totalChars: 12,
    });
    expect(second).toMatchObject({ ok: true, text: "FGHIJ", cursor: "5", nextCursor: "10" });
  });

  it("rejects invalid references and cursors", async () => {
    const resources = await store();
    const ref = await resources.putText("search_skills", "content");

    expect(await resources.readText("ctxres:../../secret", { maxChars: 5 })).toEqual({
      ok: false,
      reason: "invalid_ref",
    });
    expect(await resources.readText(ref, { cursor: "999", maxChars: 5 })).toEqual({
      ok: false,
      reason: "invalid_cursor",
    });
  });
});
