import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { chatMessageAttachments, storedFiles } from "./schema.js";

describe("chat attachment foreign keys", () => {
  it("allows project deletion to cascade through referenced stored files", () => {
    const fileReference = getTableConfig(chatMessageAttachments).foreignKeys.find(
      (foreignKey) => foreignKey.reference().foreignTable === storedFiles,
    );

    expect(fileReference?.onDelete).toBe("cascade");
  });
});
