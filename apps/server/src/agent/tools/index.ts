/** Agent 桌面工具注册入口。业务工具可暂时为空，但依赖与注册边界必须保留。 */
import type { ToolDependencies } from "./shared.js";

export function createDeskTools(_projectId: string, _dependencies: ToolDependencies) {
  // 业务工具重做中：返回空列表。恢复时在此组装，并复用 domain 规则 + createPlaced。
  return [];
}

export type { ToolDependencies } from "./shared.js";
