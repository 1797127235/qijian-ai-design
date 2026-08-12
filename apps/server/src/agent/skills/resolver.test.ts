import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveExplicitSkills } from "./resolver.js";
import { SessionSkillState } from "./session-skill-state.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("resolveExplicitSkills", () => {
  it("injects an explicit $skill once and shares the session emit ledger", async () => {
    const root = await mkdtemp(join(tmpdir(), "qijian-skill-resolver-"));
    roots.push(root);
    const state = await SessionSkillState.open({
      filePath: join(root, "skill-state.json"),
      catalogRevision: "catalog-v1",
    });

    const first = resolveExplicitSkills("请按 $design-language 处理", state);
    const second = resolveExplicitSkills("继续用 $design-language", state);

    expect(first.injected).toHaveLength(1);
    expect(first.injected[0]).toMatchObject({ id: "design-language" });
    expect(first.injected[0]?.body).toContain("设计方向");
    expect(second.injected).toEqual([]);
    expect(second.requestedIds).toEqual(["design-language"]);
    await state.flush();
  });

  it("re-injects the same explicit skill after a trajectory resync", async () => {
    const root = await mkdtemp(join(tmpdir(), "qijian-skill-resolver-"));
    roots.push(root);
    const state = await SessionSkillState.open({
      filePath: join(root, "skill-state.json"),
      catalogRevision: "catalog-v1",
    });
    resolveExplicitSkills("$desk-loop", state);
    state.forceResync();

    expect(resolveExplicitSkills("$desk-loop", state).injected).toHaveLength(1);
    await state.flush();
  });
});
