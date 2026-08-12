import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { DeskSnapshot } from "../../domain/types.js";
import type { ArtifactService } from "../../services/artifact-service.js";
import type { CanvasGenerateService, PreparedGenerate } from "../../services/canvas-generate-service.js";
import type { DeskStateService } from "../../services/desk-state-service.js";
import type { TaskStore } from "../../tasks/task-store.js";
import type { TaskPayload } from "../../tasks/types.js";
import { registerDeskRoutes } from "./desk.js";

function deskSnapshot(): DeskSnapshot {
  const projectId = crypto.randomUUID();
  const sourceId = crypto.randomUUID();
  return {
    project: { id: projectId, name: "route-test" },
    artifacts: [{
      id: sourceId,
      artifactType: "canvas_image",
      versionId: crypto.randomUUID(),
      versionNo: 1,
      status: "confirmed",
      payload: { file_id: crypto.randomUUID() },
      inputRefs: [],
      createdBy: "designer",
      createdAt: new Date(),
    }],
    deskState: {
      objects: [{ artifact_id: sourceId, kind: "canvas_image", x: 0, y: 0, rot: 0 }],
      connections: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      updatedAt: new Date(),
    },
  };
}

describe("POST generate-image BullMQ route", () => {
  it("accepts through TaskStore", async () => {
    const snapshot = deskSnapshot();
    const pendingArtifactId = crypto.randomUUID();
    const prepared = {
      pending: {
        artifact: { id: pendingArtifactId },
        version: { id: crypto.randomUUID(), status: "draft" },
        object: { artifact_id: pendingArtifactId, kind: "effect_image", x: 10, y: 10, rot: 0 },
        status: "pending",
      },
      composedPrompt: "make it bright",
      userPrompt: "make it bright",
      referenceFileIds: [],
      origin: "canvas_panel",
      createdBy: "designer",
      lockKey: `${snapshot.project.id}:${pendingArtifactId}`,
    } satisfies PreparedGenerate;
    let acceptedPayload: TaskPayload | undefined;
    const taskStore = {
      accept: async (input: {
        payload: TaskPayload;
        prepare?: (tx: never, taskId: string) => Promise<{ artifactId?: string } | void>;
      }) => {
        acceptedPayload = input.payload;
        await input.prepare?.(undefined as never, input.payload.task_id);
        return { id: input.payload.task_id };
      },
    } as unknown as TaskStore;
    const generate = { prepare: async () => prepared } as unknown as CanvasGenerateService;
    const app = new Hono();
    registerDeskRoutes(app, {
      desks: { snapshot: async () => snapshot } as unknown as DeskStateService,
      artifacts: {} as ArtifactService,
      generate,
      taskStore,
      defaultImageModel: "default-model",
    });

    const response = await app.request(`/api/projects/${snapshot.project.id}/generate-image`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "make it bright",
        sourceArtifactId: snapshot.artifacts[0].id,
        clientOpId: "route-test-op",
      }),
    });
    const body = await response.json() as { status: string; async: boolean; task_id: string; artifact: { id: string } };

    expect(response.status).toBe(201);
    expect(body).toMatchObject({ status: "accepted", async: true, artifact: { id: pendingArtifactId } });
    expect(body.task_id).toBe(acceptedPayload?.task_id);
    expect(acceptedPayload?.kind).toBe("image.generate");
  });
});
