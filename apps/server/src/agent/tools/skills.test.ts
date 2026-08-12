import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionSkillState } from "../skills/session-skill-state.js";
import { createLoadSkillTool } from "./skills.js";
import type { ToolContext } from "./shared.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function textOf(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content.map((part) => part.text ?? "").join("");
}

describe("load_skill", () => {
  it("emits a body once and returns a small cached marker for the same revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "qijian-load-skill-"));
    roots.push(root);
    const state = await SessionSkillState.open({
      filePath: join(root, "skill-state.json"),
      catalogRevision: "catalog-v1",
    });
    const tool = createLoadSkillTool({
      skillState: () => state,
    } as unknown as ToolContext);

    const first = await tool.execute(
      "call-1",
      { skill_id: "design-language" },
      undefined,
      undefined,
      {} as never,
    );
    const second = await tool.execute(
      "call-2",
      { skill_id: "design-language" },
      undefined,
      undefined,
      {} as never,
    );

    expect(textOf(first)).toContain("设计方向");
    expect(first.details).toMatchObject({ emitted: true, cached: false });
    expect(textOf(second)).not.toContain("设计方向");
    expect(textOf(second)).toContain("already_loaded");
    expect(second.details).toMatchObject({ emitted: false, cached: true });
    await state.flush();
  });
});
