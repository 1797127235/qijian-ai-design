/** Agent 工具注册入口。具体业务工具已移除，保留注册边界供后续重新设计。 */
import type { ToolDependencies } from "./shared.js";

export function createDeskTools(_projectId: string, _dependencies: ToolDependencies) {
  return [];
}

export type { ToolDependencies } from "./shared.js";
