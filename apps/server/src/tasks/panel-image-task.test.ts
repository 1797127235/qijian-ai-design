import { describe, expect, it } from "vitest";
import type { DeskSnapshot } from "../domain/types.js";
import { createPanelImageTaskPayload } from "./panel-image-task.js";

function snapshot(): DeskSnapshot {
  const projectId = crypto.randomUUID();
  const sourceId = crypto.randomUUID();
  const referenceId = crypto.randomUUID();
  return {
    project: { id: projectId, name: "test" },
    artifacts: [
      {
        id: sourceId,
        artifactType: "canvas_image",
        versionId: crypto.randomUUID(),
        versionNo: 3,
        status: "confirmed",
        payload: { file_id: crypto.randomUUID() },
        inputRefs: [],
        createdBy: "designer",
        createdAt: new Date(),
      },
      {
        id: referenceId,
        artifactType: "canvas_image",
        versionId: crypto.randomUUID(),
        versionNo: 2,
        status: "confirmed",
        payload: { file_id: crypto.randomUUID() },
        inputRefs: [],
        createdBy: "designer",
        createdAt: new Date(),
      },
    ],
    deskState: {
      objects: [],
      connections: [{ id: crypto.randomUUID(), from: referenceId, to: sourceId }],
      viewport: { x: 0, y: 0, zoom: 1 },
      updatedAt: new Date(),
    },
  };
}

describe("createPanelImageTaskPayload", () => {
  it("freezes source and inbound reference versions", () => {
    const desk = snapshot();
    const source = desk.artifacts[0];
    const reference = desk.artifacts[1];
    const payload = createPanelImageTaskPayload({
      snapshot: desk,
      taskId: crypto.randomUUID(),
      request: { prompt: "make it brighter", sourceArtifactId: source.id },
      defaultModel: "default-model",
      generationMemory: {
        checkpoint_revision: 3,
        stable_keys: ["palette.base"],
        compiled_design_context: "[PROJECT_MEMORY revision=3]\n- 低饱和暖灰",
      },
    });

    expect(payload.operation).toBe("beside");
    expect(payload.source).toMatchObject({ artifact_id: source.id, version_id: source.versionId });
    expect(payload.references).toEqual([{
      artifact_id: reference.id,
      version_id: reference.versionId,
      file_id: reference.payload.file_id,
    }]);
    expect(payload.target_version).toBe(1);
    expect(payload.generation_memory?.checkpoint_revision).toBe(3);
    expect(payload.prompt).toContain("低饱和暖灰");
    expect(payload.user_prompt).toBe("make it brighter");
  });

  it("freezes inpaint region and the post-prepare target version", () => {
    const desk = snapshot();
    const source = desk.artifacts[0];
    const region = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
    const payload = createPanelImageTaskPayload({
      snapshot: desk,
      taskId: crypto.randomUUID(),
      request: {
        prompt: "replace the chair",
        sourceArtifactId: source.id,
        targetArtifactId: source.id,
        region,
      },
      defaultModel: "default-model",
    });

    expect(payload.operation).toBe("inpaint");
    expect(payload.region).toEqual(region);
    expect(payload.target_version).toBe(source.versionNo + 1);
  });
});
