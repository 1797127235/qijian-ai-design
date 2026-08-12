/**
 * Agent 桌面工具注册入口。
 *  - 全量 customTools 注册；默认窄 base：search_tools + look_*
 *  - 其它能力（含 search_skills/load_skill）经 search_tools 发现激活
 *  - AGENT_DEBUG_IMAGE_TOOL=1 时注册 debug_return_image（仍须 search）
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createDebugReturnImageTool, isDebugImageToolEnabled } from "./debug-return-image.js";
import { createGenerateTools } from "./generate/index.js";
import { createGetTaskTool } from "./get-task.js";
import { createLookAtDeskTool } from "./look-at-desk.js";
import { createLookAtTool } from "./look-at.js";
import { createRemoveFromDeskTool } from "./remove-from-desk.js";
import { createSearchToolsTool } from "./search-tools.js";
import { createToolContext, type ToolDependencies } from "./shared.js";
import {
  createForgetMemoryTool,
  createInspectProjectMemoryTool,
  createRecordMemoryTool,
  createSearchProjectMemoryTool,
} from "./memory.js";
import { createLoadSkillTool, createSearchSkillsTool } from "./skills.js";
import { CapabilityGate, guardToolDefinition } from "../capability-gate.js";
import type { ToolRuntime } from "./shared.js";
import { createReadContextResourceTool } from "./read-context-resource.js";
import { budgetToolDefinition } from "./result-budget-wrapper.js";

export function createDeskTools(
  projectId: string,
  dependencies: ToolDependencies,
  runtime: ToolRuntime,
): ToolDefinition[] {
  const ctx = createToolContext(projectId, dependencies, runtime);
  const tools: ToolDefinition[] = [
    createSearchToolsTool(ctx),
    createLookAtDeskTool({ ...ctx, files: dependencies.files }),
    createLookAtTool({ ...ctx, files: dependencies.files }),
    createReadContextResourceTool(ctx),
    createSearchSkillsTool(),
    createLoadSkillTool(ctx),
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
  const gate = new CapabilityGate();
  return tools.map((tool) => budgetToolDefinition(
    guardToolDefinition(tool, runtime.turnContext, gate),
    runtime.resourceStore,
  ));
}

export type { ToolDependencies, ToolRuntime, ToolSessionRef } from "./shared.js";
export {
  activateTools,
  narrowBaseTools,
  SEARCH_TOOLS_NAME,
  NARROW_BASE_TOOLS,
  searchToolMatches,
} from "./tool-activation.js";
