/**
 * Agent 桌面工具注册入口。
 *  - 工具白名单：只暴露 generate_from_desk / get_task
 *  - 新增工具在这里 append；session-factory 自动透传名字给 pi
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createGenerateFromDeskTool } from "./generate-from-desk.js";
import { createGetTaskTool } from "./get-task.js";
import { createToolContext, type ToolDependencies, type ToolSessionRef } from "./shared.js";

/**
 * 拼一组工具定义：
 *  - projectId：每工具需要知道操作哪个项目
 *  - selectedArtifactIds：本轮画布选中（getter，prompt 期间有效）
 *  - session：threadId + 当前 runId（写 job 用）
 */
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
