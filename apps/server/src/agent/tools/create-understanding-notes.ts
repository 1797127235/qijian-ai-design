/** 生成工具：基于已有 Brief 和空间地图创建理解便签 Artifact。 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ok, type ToolContext } from "./shared.js";

export function createUnderstandingNotesTool({ projectId, deps, place }: ToolContext) {
  return defineTool({
    name: "create_understanding_notes",
    label: "创建理解便签",
    description: "基于 Brief 和空间地图创建若干条独立的理解便签草稿",
    parameters: Type.Object({
      notes: Type.Array(Type.Object({
        space_id: Type.String(),
        text: Type.String(),
        x: Type.Number(),
        y: Type.Number(),
      }), { minItems: 1 }),
    }),
    execute: async (_id, params, signal) => {
      const snapshot = await deps.desks.snapshot(projectId);
      if (!snapshot.artifacts.some((artifact) => artifact.artifactType === "design_brief")) {
        throw new Error("请先创建 design_brief");
      }
      const spaceMap = snapshot.artifacts.find((artifact) => artifact.artifactType === "space_map");
      if (!spaceMap) throw new Error("请先创建 space_map");
      const spaces = Array.isArray(spaceMap.payload.spaces)
        ? spaceMap.payload.spaces
        : Array.isArray(spaceMap.payload.regions) ? spaceMap.payload.regions : [];
      const spaceIds = new Set(spaces.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const value = item as Record<string, unknown>;
        const id = value.space_id ?? value.id;
        return typeof id === "string" ? [id] : [];
      }));
      if (params.notes.some((note) => !spaceIds.has(note.space_id))) {
        throw new Error("理解便签的 space_id 必须来自空间地图");
      }
      await deps.gate.check(projectId, "create_understanding_notes", params, `创建 ${params.notes.length} 张理解便签`, signal);
      const artifactIds: string[] = [];
      for (const [index, note] of params.notes.entries()) {
        const result = await deps.artifacts.create(projectId, "understanding_note", {
          payload: { space_id: note.space_id, who: "AI 理解", text: note.text },
          createdBy: "agent",
        });
        artifactIds.push(result.artifact.id);
        await place(result.artifact.id, "note", note.x, note.y, index % 2 ? -1.5 : 1);
      }
      return ok(`已创建 ${artifactIds.length} 张理解便签`, { artifactIds });
    },
  });
}
