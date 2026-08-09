/**
 * Agent 桌面工具注册入口。
 *  - 工具白名单：generate_from_desk / get_task / look_at_desk / look_at
 *  - AGENT_DEBUG_IMAGE_TOOL=1 时追加 debug_return_image（toolResult 附图探针）
 *  - 新增工具在这里 append；session-factory 自动透传名字给 pi
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createDebugReturnImageTool, isDebugImageToolEnabled } from "./debug-return-image.js";
import { createGenerateFromDeskTool } from "./generate-from-desk.js";
import { createGetTaskTool } from "./get-task.js";
import { createLookAtDeskTool } from "./look-at-desk.js";
import { createLookAtTool } from "./look-at.js";
import { createToolContext, type ToolDependencies, type ToolSessionRef } from "./shared.js";

/**
 * 拼一组工具定义：
 *  - projectId：每工具需要知道操作哪个项目
 *  - selectedArtifactIds：本轮 prompt 的画布选中（getter，prompt 期间有效）
 *  - session：threadId + 当前 runId（写 job 用）
 */
export function createDeskTools(
  projectId: string,
  dependencies: ToolDependencies,
  selectedArtifactIds: () => string[] = () => [],
  session?: ToolSessionRef,
): ToolDefinition[] {
  const ctx = createToolContext(projectId, dependencies, selectedArtifactIds, session);
  const tools: ToolDefinition[] = [
    createGenerateFromDeskTool(ctx),
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
