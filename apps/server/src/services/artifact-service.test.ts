import { describe, expect, it } from "vitest";
import type { Database } from "../db/client.js";
import { ArtifactService } from "./artifact-service.js";

const service = new ArtifactService({} as Database);

describe("Artifact confirmation contract", () => {
  it("rejects an empty confirmed brief before touching the database", async () => {
    await expect(service.create("project", "design_brief", {
      payload: { text: "" },
      status: "confirmed",
      createdBy: "designer",
    })).rejects.toThrow("确认 design_brief 前必须填写内容");
  });

  it("requires a selected direction among exactly three cards", async () => {
    await expect(service.create("project", "design_directions", {
      payload: {
        directions: [{ id: "a" }, { id: "b" }, { id: "c" }],
        selected_direction_id: null,
      },
      status: "confirmed",
      createdBy: "agent",
    })).rejects.toThrow("必须从三个方向中选择一个");
  });

  it("requires mapped spaces before confirming a space map", async () => {
    await expect(service.create("project", "space_map", {
      payload: { spaces: [] },
      status: "confirmed",
      createdBy: "designer",
    })).rejects.toThrow("必须标注空间区域");
  });
});
