import { describe, expect, it } from "vitest";
import type { Database } from "../db/client.js";
import { ArtifactService } from "./artifact-service.js";

const service = new ArtifactService({} as Database);

describe("Artifact payload validation", () => {
  it("rejects removed types", async () => {
    await expect(service.create("project", "space_map" as never, {
      payload: {},
      createdBy: "designer",
    })).rejects.toThrow("不支持的 Artifact 类型");
    await expect(service.create("project", "proposal_package" as never, {
      payload: {},
      createdBy: "designer",
    })).rejects.toThrow("不支持的 Artifact 类型");
  });
});
