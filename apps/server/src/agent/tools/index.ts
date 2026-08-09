/**
 * Agent 桌面工具注册入口。
 *  - 工具白名单：generate_* / replace_on_desk / text_to_image_on_desk / remove_from_desk / get_task / look_at*
 *  - AGENT_DEBUG_IMAGE_TOOL=1 时追加 debug_return_image
 *  - 生图工具见 tools/generate/
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createDebugReturnImageTool, isDebugImageToolEnabled } from "./debug-return-image.js";
import { createGenerateTools } from "./generate/index.js";
import { createGetTaskTool } from "./get-task.js";
import { createLookAtDeskTool } from "./look-at-desk.js";
import { createLookAtTool } from "./look-at.js";
import { createRemoveFromDeskTool } from "./remove-from-desk.js";
import { createToolContext, type ToolDependencies, type ToolSessionRef } from "./shared.js";

export function createDeskTools(
  projectId: string,
  dependencies: ToolDependencies,
  selectedArtifactIds: () => string[] = () => [],
  session?: ToolSessionRef,
): ToolDefinition[] {
  const ctx = createToolContext(projectId, dependencies, selectedArtifactIds, session);
  const tools: ToolDefinition[] = [
    ...createGenerateTools(ctx),
    createRemoveFromDeskTool(ctx),
    createGetTaskTool(ctx),
    createLookAtDeskTool({ ...ctx, files: dependencies.files }),
    createLookAtTool({ ...ctx, files: dependencies.files }),
  ];
  if (isDebugImageToolEnabled()) {
    tools.push(createDebugReturnImageTool());
  }
  return tools;
}

export type { ToolDependencies, ToolSessionRef } from "./shared.js";
