import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionSkillState } from "./session-skill-state.js";

const roots: string[] = [];

async function stateFile() {
  const root = await mkdtemp(join(tmpdir(), "qijian-skill-state-"));
  roots.push(root);
  return join(root, "skill-state.json");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SessionSkillState", () => {
  it("emits the same skill revision only once in a trajectory", async () => {
    const state = await SessionSkillState.open({
      filePath: await stateFile(),
      catalogRevision: "catalog-v1",
    });

    expect(state.recordLoad("design-language", "skill-v1").emit).toBe(true);
    expect(state.recordLoad("design-language", "skill-v1").emit).toBe(false);
    expect(state.snapshot().loadedRevisions).toEqual({ "design-language": "skill-v1" });
    await state.flush();
  });

  it("persists emit-once state and emits a changed revision", async () => {
    const filePath = await stateFile();
    const state = await SessionSkillState.open({ filePath, catalogRevision: "catalog-v1" });
    state.recordLoad("design-language", "skill-v1");
    await state.flush();

    const restored = await SessionSkillState.open({ filePath, catalogRevision: "catalog-v1" });
    expect(restored.recordLoad("design-language", "skill-v1").emit).toBe(false);
    expect(restored.recordLoad("design-language", "skill-v2").emit).toBe(true);
    await restored.flush();
  });

  it("keeps loaded revisions but allows deterministic re-emission after compaction", async () => {
    const state = await SessionSkillState.open({
      filePath: await stateFile(),
      catalogRevision: "catalog-v1",
    });
    state.recordLoad("design-language", "skill-v1");

    state.forceResync();

    expect(state.snapshot()).toMatchObject({
      trajectoryEpoch: 2,
      loadedRevisions: { "design-language": "skill-v1" },
      emittedRevisions: {},
    });
    expect(state.recordLoad("design-language", "skill-v1").emit).toBe(true);
    await state.flush();
  });

  it("starts a clean trajectory when the catalog revision changes", async () => {
    const filePath = await stateFile();
    const state = await SessionSkillState.open({ filePath, catalogRevision: "catalog-v1" });
    state.recordLoad("design-language", "skill-v1");
    await state.flush();

    const changed = await SessionSkillState.open({ filePath, catalogRevision: "catalog-v2" });
    expect(changed.snapshot()).toMatchObject({
      catalogRevision: "catalog-v2",
      trajectoryEpoch: 2,
      loadedRevisions: {},
      emittedRevisions: {},
    });
    await changed.flush();
  });
});
