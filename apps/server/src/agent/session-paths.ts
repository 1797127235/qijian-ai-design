import { resolve } from "node:path";

/**
 * Agent session 目录布局：data/agent-sessions/<projectId>/<threadId>/
 *  - 每个 chat thread 独占一个目录，pi 用它存会话历史
 *  - 删项目/thread 时连目录一起清
 */
export function agentSessionDir(
  projectId: string,
  threadId: string,
  root = resolve("data/agent-sessions"),
) {
  return resolve(root, projectId, threadId);
}
