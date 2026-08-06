/** Agent 桌面工具注册入口。工具实现均放在本目录。 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createGenerateFromDeskTool } from "./generate-from-desk.js";
import { createToolContext, type ToolDependencies } from "./shared.js";

export function createDeskTools(
  projectId: string,
  dependencies: ToolDependencies,
  selectedArtifactIds: () => string[] = () => [],
): ToolDefinition[] {
  const ctx = createToolContext(projectId, dependencies, selectedArtifactIds);
  return [createGenerateFromDeskTool(ctx)];
}

export type { ToolDependencies } from "./shared.js";
