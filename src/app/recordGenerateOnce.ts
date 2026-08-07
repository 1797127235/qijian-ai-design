import type { DeskHistoryEntry, DeskHistoryOp } from "./useDeskHistory";

/** 同一 artifact 只记一条 generate history（面板 accepted 与 agent object_changed 去重）。 */
export function createGenerateHistoryGate() {
  const seen = new Set<string>();

  return {
    tryRecord(
      artifactId: string,
      record: (op: DeskHistoryOp) => void,
      entry: DeskHistoryEntry,
      connections: { id: string; from: string; to: string } | { id: string; from: string; to: string }[],
    ) {
      if (seen.has(artifactId)) return false;
      seen.add(artifactId);
      const list = Array.isArray(connections) ? connections : [connections];
      record({ type: "generate", entry, connections: list });
      return true;
    },
    /** 项目切换时清空 */
    reset() {
      seen.clear();
    },
  };
}
