/**
 * Agent 桌面工具注册入口。
 *  - 全量 customTools 注册；默认仅窄 base 激活（search_tools + look_*）
 *  - 其它能力经 search_tools 发现激活
 *  - AGENT_DEBUG_IMAGE_TOOL=1 时注册 debug_return_image（仍须 search）
 */
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createDebugReturnImageTool, isDebugImageToolEnabled } from "./debug-return-image.js";
import { createGenerateTools } from "./generate/index.js";
import { createGetTaskTool } from "./get-task.js";
import { createLookAtDeskTool } from "./look-at-desk.js";
import { createLookAtTool } from "./look-at.js";
import { createRemoveFromDeskTool } from "./remove-from-desk.js";
import { createSearchToolsTool } from "./search-tools.js";
import { createToolContext, type ToolDependencies, type ToolSessionRef } from "./shared.js";
import {
  createForgetMemoryTool,
  createInspectProjectMemoryTool,
  createRecordMemoryTool,
  createSearchProjectMemoryTool,
} from "./memory.js";

export function createDeskTools(
  projectId: string,
  dependencies: ToolDependencies,
  selectedArtifactIds: () => string[] = () => [],
  session?: ToolSessionRef,
  activation?: {
    agentSession: () => AgentSession | undefined;
    identityPrompt: () => string;
  },
): ToolDefinition[] {
  const ctx = createToolContext(projectId, dependencies, selectedArtifactIds, session, activation);
  const tools: ToolDefinition[] = [
    createSearchToolsTool(ctx),
    createLookAtDeskTool({ ...ctx, files: dependencies.files }),
    createLookAtTool({ ...ctx, files: dependencies.files }),
    ...createGenerateTools(ctx),
    createRemoveFromDeskTool(ctx),
    createGetTaskTool(ctx),
    createInspectProjectMemoryTool(ctx),
    createSearchProjectMemoryTool(ctx),
    createRecordMemoryTool(ctx),
    createForgetMemoryTool(ctx),
  ];
  if (isDebugImageToolEnabled()) {
    tools.push(createDebugReturnImageTool());
  }
  return tools;
}

export type { ToolDependencies, ToolSessionRef } from "./shared.js";
export {
  applyToolActivation,
  narrowBaseTools,
  wakeTools,
  SEARCH_TOOLS_NAME,
  NARROW_BASE_TOOLS,
  WAKE_TOOLS,
  buildToolPolicy,
  searchToolMatches,
  composeSystemPrompt,
} from "./tool-activation.js";
