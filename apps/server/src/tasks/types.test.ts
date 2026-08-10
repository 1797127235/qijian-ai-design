import { describe, expect, it } from "vitest";
import { taskPayloadSchema } from "./types.js";

const baseImage = {
  schema_version: 1,
  kind: "image.generate",
  project_id: "11111111-1111-4111-8111-111111111111",
  task_id: "22222222-2222-4222-8222-222222222222",
  references: [],
  target_version: 0,
  prompt: "生成客厅效果图",
  model: "image-model",
  origin: { type: "panel", name: "generate-image" },
};

describe("taskPayloadSchema", () => {
  it("accepts a versioned spawn image task", () => {
    const parsed = taskPayloadSchema.parse({ ...baseImage, operation: "spawn" });
    expect(parsed.kind).toBe("image.generate");
  });

  it("requires a frozen source for beside and replace", () => {
    for (const operation of ["beside", "replace", "inpaint"]) {
      expect(() => taskPayloadSchema.parse({ ...baseImage, operation })).toThrow();
    }
  });

  it("rejects unknown schema versions and task kinds", () => {
    expect(() => taskPayloadSchema.parse({ ...baseImage, operation: "spawn", schema_version: 2 })).toThrow();
    expect(() => taskPayloadSchema.parse({ ...baseImage, operation: "spawn", kind: "unknown" })).toThrow();
  });

  it("accepts a versioned artifact name task", () => {
    const parsed = taskPayloadSchema.parse({
      schema_version: 1,
      kind: "artifact.name",
      project_id: "11111111-1111-4111-8111-111111111111",
      task_id: "22222222-2222-4222-8222-222222222222",
      artifact_id: "33333333-3333-4333-8333-333333333333",
      artifact_version_id: "44444444-4444-4444-8444-444444444444",
      name_version: 3,
      generation_token: "token-1",
      display_name_source: "model",
      naming_input: "现代原木客厅",
    });
    expect(parsed.kind).toBe("artifact.name");
  });
});
