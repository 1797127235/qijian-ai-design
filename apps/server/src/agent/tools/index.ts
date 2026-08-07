/** Agent 桌面工具注册入口。工具实现均放在本目录。 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createGenerateFromDeskTool } from "./generate-from-desk.js";
import { createGetTaskTool } from "./get-task.js";
import { createToolContext, type ToolDependencies, type ToolSessionRef } from "./shared.js";

export function createDeskTools(
  projectId: string,
  dependencies: ToolDependencies,
  selectedArtifactIds: () => string[] = () => [],
  session?: ToolSessionRef,
): ToolDefinition[] {
  const ctx = createToolContext(projectId, dependencies, selectedArtifactIds, session);
  return [
    createGenerateFromDeskTool(ctx),
    createGetTaskTool(ctx),
  ];
}

export type { ToolDependencies, ToolSessionRef } from "./shared.js";
