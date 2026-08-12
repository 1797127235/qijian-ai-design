import { describe, expect, it } from "vitest";
import {
  listSkillMeta,
  loadSkillBody,
  searchSkillMeta,
  skillCatalogRevision,
} from "./catalog.js";
import { resolveUnderRoot, skillsRoot } from "./paths.js";

describe("skills catalog", () => {
  it("lists built-in skills with titles", () => {
    const all = listSkillMeta();
    expect(all.some((s) => s.id === "design-language")).toBe(true);
    expect(all.some((s) => s.id === "desk-loop")).toBe(true);
    const lang = all.find((s) => s.id === "design-language");
    expect(lang?.title).toBeTruthy();
    expect(lang?.title).not.toBe("design-language");
    expect(lang?.summary).toBeTruthy();
    expect(lang!.summary.length).toBeLessThan(lang!.description.length);
    expect(lang?.revision).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(lang?.baseDir).toContain("/skills/design-language");
    expect(skillCatalogRevision()).toMatch(/^sha256:[0-9a-f]{16}$/);
  });

  it("search and load body", () => {
    expect(searchSkillMeta("视觉语言").some((s) => s.id === "design-language")).toBe(true);
    expect(searchSkillMeta("画布 生图").some((s) => s.id === "desk-loop")).toBe(true);
    const body = loadSkillBody("design-language", 6000);
    expect(body.ok).toBe(true);
    if (body.ok) {
      expect(body.body).toContain("设计方向");
      expect(body.truncated).toBe(false);
      expect(body.revision).toBe(
        listSkillMeta().find((skill) => skill.id === "design-language")?.revision,
      );
      expect(body.baseDir).toContain("/skills/design-language");
    }
    const loop = loadSkillBody("desk-loop", 6000);
    expect(loop.ok).toBe(true);
    if (loop.ok) {
      expect(loop.body).toContain("generate_from_desk");
    }
  });

  it("rejects invalid id and traversal", () => {
    expect(loadSkillBody("../etc", 1000).ok).toBe(false);
    expect(loadSkillBody("not-a-real-skill-xyz", 1000).ok).toBe(false);
    expect(resolveUnderRoot(skillsRoot(), "../package.json")).toBeNull();
  });
});
