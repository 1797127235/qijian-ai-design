import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeskAliasRegistry } from "./desk-alias-registry.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("DeskAliasRegistry", () => {
  it("keeps project aliases stable across removals, additions and resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "qijian-desk-alias-"));
    roots.push(root);
    const filePath = join(root, "desk-aliases.json");
    const registry = await DeskAliasRegistry.open(filePath);

    expect(registry.assign(["art-a", "art-b"])).toEqual({
      "art-a": "A01",
      "art-b": "A02",
    });
    expect(registry.assign(["art-b", "art-c"])).toEqual({
      "art-b": "A02",
      "art-c": "A03",
    });
    await registry.flush();

    const restored = await DeskAliasRegistry.open(filePath);
    expect(restored.assign(["art-c", "art-a"])).toEqual({
      "art-c": "A03",
      "art-a": "A01",
    });
  });
});
