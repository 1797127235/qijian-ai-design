import { resolve } from "node:path";

/** 每个 chat thread 独占一个 pi session 目录，continueRecent 即 resume。 */
export function agentSessionDir(
  projectId: string,
  threadId: string,
  root = resolve("data/agent-sessions"),
) {
  return resolve(root, projectId, threadId);
}
