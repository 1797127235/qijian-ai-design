import type { Hono } from "hono";
import { z } from "zod";
import { artifactTypes } from "../../domain/types.js";
import type { ArtifactService } from "../../services/artifact-service.js";
import { body } from "./shared.js";

const artifactTypeSchema = z.enum(artifactTypes);
const versionSchema = z.object({
  payload: z.record(z.string(), z.unknown()),
  inputRefs: z.array(z.unknown()).optional(),
  status: z.enum(["draft", "confirmed"]).optional(),
  createdBy: z.enum(["designer", "agent"]).default("designer"),
  changeReason: z.string().max(500).optional(),
});

export function registerArtifactRoutes(app: Hono, deps: { artifacts: ArtifactService }) {
  app.post("/api/projects/:id/artifacts", async (c) => {
    const input = await body(c.req.raw, z.object({
      artifactType: artifactTypeSchema,
      ...versionSchema.shape,
      layout: z.object({ kind: z.string(), x: z.number(), y: z.number(), rot: z.number().default(0), w: z.number().optional() }).optional(),
    }));
    const projectId = c.req.param("id");
    if (input.layout) {
      const { layout, artifactType, ...version } = input;
      return c.json(await deps.artifacts.createPlaced(projectId, artifactType, version, layout), 201);
    }
    return c.json(await deps.artifacts.create(projectId, input.artifactType, input), 201);
  });

  app.post("/api/artifacts/:id/versions", async (c) => {
    const input = await body(c.req.raw, versionSchema);
    return c.json(await deps.artifacts.append(c.req.param("id"), input), 201);
  });

  app.post("/api/artifacts/:id/confirm", async (c) => c.json(await deps.artifacts.confirm(c.req.param("id"), "designer")));

  app.post("/api/artifacts/:id/rollback", async (c) => {
    const input = await body(c.req.raw, z.object({ versionId: z.string().uuid().optional() }));
    return c.json(await deps.artifacts.rollback(c.req.param("id"), input.versionId));
  });
}
