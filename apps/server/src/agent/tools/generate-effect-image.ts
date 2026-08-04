/** 付费生成工具：为已确认的关键空间和设计方向生成效果图变体。 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ok, type ToolContext } from "./shared.js";

export function createEffectImageTool({ projectId, deps, place }: ToolContext) {
  return defineTool({
    name: "generate_effect_image",
    label: "生成效果图",
    description: "为指定关键空间生成一个效果图变体",
    parameters: Type.Object({
      space_id: Type.String(),
      intent: Type.Optional(Type.String()),
      x: Type.Optional(Type.Number()),
      y: Type.Optional(Type.Number()),
    }),
    execute: async (_id, params, signal) => {
      const snapshot = await deps.desks.snapshot(projectId);
      const spaceMap = snapshot.artifacts.find((artifact) => artifact.artifactType === "space_map" && artifact.status === "confirmed");
      const spaces = Array.isArray(spaceMap?.payload.spaces)
        ? spaceMap.payload.spaces
        : Array.isArray(spaceMap?.payload.regions) ? spaceMap.payload.regions : [];
      const space = spaces.find((item) => {
        if (!item || typeof item !== "object") return false;
        const candidate = item as Record<string, unknown>;
        return candidate.id === params.space_id || candidate.space_id === params.space_id;
      }) as Record<string, unknown> | undefined;
      if (!space || (space.key !== true && space.is_key_space !== true)) {
        throw new Error("space_id 必须是已确认空间地图中的关键空间");
      }
      const directions = snapshot.artifacts.find((artifact) => artifact.artifactType === "design_directions" && artifact.status === "confirmed");
      if (!directions?.payload.selected_direction_id) throw new Error("请先选择并确认设计方向");
      await deps.gate.check(projectId, "generate_effect_image", params, `为 ${params.space_id} 生成效果图（会产生模型费用）`, signal);
      const generated = await deps.effects.generate({
        spaceId: params.space_id,
        intent: params.intent,
        context: JSON.stringify(snapshot.artifacts),
      });
      const result = await deps.artifacts.create(projectId, "effect_image", {
        payload: {
          space_id: params.space_id,
          url: generated.url,
          provider_id: generated.providerId,
          adopted: false,
        },
        createdBy: "agent",
      });
      await place(result.artifact.id, "effect_image", params.x ?? 1320, params.y ?? 590);
      return ok("效果图变体已生成", { artifactId: result.artifact.id, url: generated.url });
    },
  });
}
