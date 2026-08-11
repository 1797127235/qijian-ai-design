import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { projectMemories, projects } from "../../db/schema.js";

describe("project memory schema", () => {
  it("stores one row per project and cascades on project delete", () => {
    const config = getTableConfig(projectMemories);
    expect(config.name).toBe("project_memories");
    const projectReference = config.foreignKeys.find(
      (foreignKey) => foreignKey.reference().foreignTable === projects,
    );
    expect(projectReference?.onDelete).toBe("cascade");
  });
});
