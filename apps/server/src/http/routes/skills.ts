/**
 * 内置 skill 列表（L1 元数据），供 composer 技能菜单。
 */
import type { Hono } from "hono";
import { listSkillMeta } from "../../agent/skills/catalog.js";

export function registerSkillRoutes(app: Hono) {
  app.get("/api/skills", (c) => {
    const skills = listSkillMeta().map((s) => ({
      id: s.id,
      name: s.name,
      title: s.title,
      description: s.description,
      summary: s.summary,
    }));
    return c.json({ skills });
  });
}
