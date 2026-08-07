import type { DeskHistoryEntry, DeskHistoryOp } from "./useDeskHistory";

/** 同一 artifact 只记一条 generate history（面板 accepted 与 agent object_changed 去重）。 */
export function createGenerateHistoryGate() {
  const seen = new Set<string>();

  return {
    tryRecord(
      artifactId: string,
      record: (op: DeskHistoryOp) => void,
      entry: DeskHistoryEntry,
      connection: { id: string; from: string; to: string },
    ) {
      if (seen.has(artifactId)) return false;
      seen.add(artifactId);
      record({ type: "generate", entry, connection });
      return true;
    },
    /** 项目切换时清空 */
    reset() {
      seen.clear();
    },
  };
}
