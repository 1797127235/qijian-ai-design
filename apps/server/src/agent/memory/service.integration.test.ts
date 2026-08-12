import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../../db/client.js";
import { projects } from "../../db/schema.js";
import { ProjectMemoryService } from "./service.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

let db: Database | undefined;
let pool: { end: () => Promise<void> } | undefined;

beforeAll(() => {
  if (!databaseUrl) return;
  const created = createDatabase({ databaseUrl } as never);
  db = created.db;
  pool = created.pool;
});

afterAll(async () => {
  await pool?.end();
});

describeDb("ProjectMemoryService minimal", () => {
  it("writes, overwrites, freezes, and forgets", async () => {
    const project = await db!.insert(projects).values({ name: "极简记忆" }).returning({ id: projects.id });
    const projectId = project[0].id;
    const service = new ProjectMemoryService(db!);
    try {
      const first = await service.write(projectId, {
        stableKey: "materials.primary",
        family: "visual_system",
        summary: "浅木",
        body: "浅色天然木",
      });
      expect(first.revision).toBe(1);
      expect(first.compiledContext).toContain("浅木");

      const second = await service.write(projectId, {
        stableKey: "materials.primary",
        family: "visual_system",
        summary: "灰色洞石",
        body: "灰色洞石",
      });
      expect(second.revision).toBe(2);
      expect(second.compiledContext).toContain("灰色洞石");
      expect(second.compiledContext).not.toContain("浅木");

      const frozen = await service.freezeForGeneration(projectId);
      expect(frozen.checkpoint_revision).toBe(2);
      expect(frozen.stable_keys).toEqual(["materials.primary"]);
      expect(frozen.compiled_design_context).toContain("灰色洞石");

      const forgotten = await service.forget(projectId, "materials.primary");
      expect(forgotten.forgotten).toBe(true);
      expect(forgotten.state.revision).toBe(3);
      expect(forgotten.state.entries["materials.primary"]).toBeUndefined();
      expect((await service.forget(projectId, "materials.primary")).forgotten).toBe(false);
      expect((await service.search(projectId, "洞石"))).toEqual([]);
    } finally {
      await db!.delete(projects).where(eq(projects.id, projectId));
    }
  });
});
