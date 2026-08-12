import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionToolState,
  orderAdditiveTools,
} from "./session-tool-state.js";

const roots: string[] = [];

async function stateFile() {
  const root = await mkdtemp(join(tmpdir(), "qijian-tool-state-"));
  roots.push(root);
  return join(root, "tool-state.json");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const registry = [
  "search_tools",
  "look_at",
  "look_at_desk",
  "generate_from_desk",
  "replace_on_desk",
  "remove_from_desk",
];
const kernel = ["search_tools", "look_at", "look_at_desk"];

describe("SessionToolState", () => {
  it("orders additions by the immutable registry without moving active tools", () => {
    expect(orderAdditiveTools(
      kernel,
      ["remove_from_desk", "generate_from_desk", "look_at"],
      registry,
    )).toEqual([...kernel, "generate_from_desk", "remove_from_desk"]);
  });

  it("persists used tools and restores them in registry order", async () => {
    const filePath = await stateFile();
    const state = await SessionToolState.open({
      filePath,
      registryNames: registry,
      registryRevision: "registry-v1",
      kernelNames: kernel,
      capacity: 5,
    });

    state.recordUse("remove_from_desk");
    state.recordUse("generate_from_desk");
    await state.flush();

    const restored = await SessionToolState.open({
      filePath,
      registryNames: registry,
      registryRevision: "registry-v1",
      kernelNames: kernel,
      capacity: 5,
    });
    expect(restored.snapshot().workingSet).toEqual(["remove_from_desk", "generate_from_desk"]);
    expect(restored.desiredActiveTools()).toEqual([
      ...kernel,
      "generate_from_desk",
      "remove_from_desk",
    ]);
  });

  it("evicts by LRU and advances tool epoch only at a replacement boundary", async () => {
    const filePath = await stateFile();
    const state = await SessionToolState.open({
      filePath,
      registryNames: registry,
      registryRevision: "registry-v1",
      kernelNames: kernel,
      capacity: 2,
    });
    state.recordBoundary([], kernel);
    const searched = orderAdditiveTools(
      kernel,
      ["generate_from_desk", "remove_from_desk", "replace_on_desk"],
      registry,
    );
    state.recordActiveSet(searched);
    state.recordDiscovery(["remove_from_desk", "generate_from_desk"]);
    state.recordUse("generate_from_desk");
    state.recordDiscovery(["replace_on_desk"]);

    expect(state.snapshot()).toMatchObject({
      toolEpoch: 1,
      workingSet: ["generate_from_desk", "replace_on_desk"],
    });
    const desired = state.desiredActiveTools();
    expect(desired).toEqual([...kernel, "generate_from_desk", "replace_on_desk"]);

    state.recordBoundary(searched, desired);
    await state.flush();

    expect(state.snapshot().toolEpoch).toBe(2);
    const persisted = JSON.parse(await readFile(filePath, "utf8"));
    expect(persisted.toolEpoch).toBe(2);
    expect(persisted.lastActiveTools).toEqual(desired);
  });

  it("starts a clean registry epoch when tool schemas change", async () => {
    const filePath = await stateFile();
    const state = await SessionToolState.open({
      filePath,
      registryNames: registry,
      registryRevision: "registry-v1",
      kernelNames: kernel,
      capacity: 5,
    });
    state.recordUse("generate_from_desk");
    state.recordActiveSet([...kernel, "generate_from_desk"]);
    await state.flush();

    const changed = await SessionToolState.open({
      filePath,
      registryNames: registry,
      registryRevision: "registry-v2",
      kernelNames: kernel,
      capacity: 5,
    });
    expect(changed.snapshot()).toMatchObject({
      registryRevision: "registry-v2",
      toolEpoch: 2,
      workingSet: [],
      lastActiveTools: [],
    });
    await changed.flush();
  });
});
