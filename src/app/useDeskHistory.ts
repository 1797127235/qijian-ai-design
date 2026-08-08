import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ArtifactSnapshot } from "../lib/api";

/** 撤销删除/重做放置所需的完整重建数据（同 id 重建，见设计文档 T1 决策）。 */
export interface DeskHistoryEntry {
  artifactId: string;
  artifactType: "canvas_image" | "effect_image";
  payload: Record<string, unknown>;
  inputRefs?: unknown[];
  layout: { kind: string; x: number; y: number; rot: number; w?: number };
}

/** 同卡版本填回（空占位上传/生成）：undo 写回 from，不删物件。 */
export type FillVersionSlice = {
  payload: Record<string, unknown>;
  inputRefs?: unknown[];
};

export type DeskHistoryOp =
  | { type: "place"; entry: DeskHistoryEntry }
  | { type: "remove"; entry: DeskHistoryEntry }
  | { type: "move"; artifactId: string; from: { x: number; y: number }; to: { x: number; y: number } }
  | { type: "place_connection"; connection: { id: string; from: string; to: string } }
  | { type: "remove_connection"; connection: { id: string; from: string; to: string } }
  | { type: "generate"; entry: DeskHistoryEntry; connections: { id: string; from: string; to: string }[] }
  | { type: "fill_version"; artifactId: string; from: FillVersionSlice; to: FillVersionSlice };

export interface DeskHistoryStacks {
  past: DeskHistoryOp[];
  future: DeskHistoryOp[];
}

export const HISTORY_CAP = 50;

export const emptyStacks = (): DeskHistoryStacks => ({ past: [], future: [] });

export const canUndo = (stacks: DeskHistoryStacks) => stacks.past.length > 0;
export const canRedo = (stacks: DeskHistoryStacks) => stacks.future.length > 0;

export function pushOp(stacks: DeskHistoryStacks, op: DeskHistoryOp): DeskHistoryStacks {
  return { past: [...stacks.past.slice(-(HISTORY_CAP - 1)), op], future: [] };
}

export function takeUndo(stacks: DeskHistoryStacks): { stacks: DeskHistoryStacks; op?: DeskHistoryOp } {
  const op = stacks.past[stacks.past.length - 1];
  if (!op) return { stacks };
  return { stacks: { past: stacks.past.slice(0, -1), future: [...stacks.future, op] }, op };
}

export function takeRedo(stacks: DeskHistoryStacks): { stacks: DeskHistoryStacks; op?: DeskHistoryOp } {
  const op = stacks.future[stacks.future.length - 1];
  if (!op) return { stacks };
  return { stacks: { past: [...stacks.past, op], future: stacks.future.slice(0, -1) }, op };
}

async function applyInverse(projectId: string, op: DeskHistoryOp): Promise<void> {
  switch (op.type) {
    case "place":
      await api.deleteObject(projectId, op.entry.artifactId);
      return;
    case "remove":
      await api.createArtifact(projectId, {
        artifactType: op.entry.artifactType,
        payload: op.entry.payload,
        inputRefs: op.entry.inputRefs,
        artifactId: op.entry.artifactId,
        layout: op.entry.layout,
      });
      return;
    case "move":
      await api.moveObject(projectId, op.artifactId, { x: Math.round(op.from.x), y: Math.round(op.from.y) });
      return;
    case "place_connection":
      await api.deleteConnection(projectId, op.connection.id);
      return;
    case "remove_connection":
      await api.createConnection(projectId, {
        from: op.connection.from,
        to: op.connection.to,
        connectionId: op.connection.id,
      });
      return;
    case "generate":
      await api.deleteObject(projectId, op.entry.artifactId);
      return;
    case "fill_version":
      await api.appendVersion(op.artifactId, op.from.payload, op.from.inputRefs);
      return;
  }
}

async function applyForward(projectId: string, op: DeskHistoryOp): Promise<void> {
  switch (op.type) {
    case "place":
      await api.createArtifact(projectId, {
        artifactType: op.entry.artifactType,
        payload: op.entry.payload,
        inputRefs: op.entry.inputRefs,
        artifactId: op.entry.artifactId,
        layout: op.entry.layout,
      });
      return;
    case "remove":
      await api.deleteObject(projectId, op.entry.artifactId);
      return;
    case "move":
      await api.moveObject(projectId, op.artifactId, { x: Math.round(op.to.x), y: Math.round(op.to.y) });
      return;
    case "place_connection":
      await api.createConnection(projectId, {
        from: op.connection.from,
        to: op.connection.to,
        connectionId: op.connection.id,
      });
      return;
    case "remove_connection":
      await api.deleteConnection(projectId, op.connection.id);
      return;
    case "generate": {
      await api.createArtifact(projectId, {
        artifactType: op.entry.artifactType,
        payload: op.entry.payload,
        inputRefs: op.entry.inputRefs,
        artifactId: op.entry.artifactId,
        layout: op.entry.layout,
      });
      try {
        for (const connection of op.connections) {
          await api.createConnection(projectId, {
            from: connection.from,
            to: connection.to,
            connectionId: connection.id,
          });
        }
      } catch (error) {
        // 部分成功时回滚 artifact，避免 history 与桌面不一致
        await api.deleteObject(projectId, op.entry.artifactId).catch(() => undefined);
        throw error;
      }
      return;
    }
    case "fill_version":
      await api.appendVersion(op.artifactId, op.to.payload, op.to.inputRefs);
      return;
  }
}

export function useDeskHistory(options: {
  projectId?: string;
  enqueue: <T>(task: () => Promise<T>) => Promise<T>;
  refreshDesk: (projectId: string) => Promise<unknown>;
  onError: (message: string) => void;
}) {
  const { projectId, enqueue, refreshDesk, onError } = options;
  const stacksRef = useRef<DeskHistoryStacks>(emptyStacks());
  const [flags, setFlags] = useState({ canUndo: false, canRedo: false });

  useEffect(() => {
    stacksRef.current = emptyStacks();
    setFlags({ canUndo: false, canRedo: false });
  }, [projectId]);

  const syncFlags = useCallback(() => {
    setFlags({ canUndo: canUndo(stacksRef.current), canRedo: canRedo(stacksRef.current) });
  }, []);

  const record = useCallback(
    (op: DeskHistoryOp) => {
      stacksRef.current = pushOp(stacksRef.current, op);
      syncFlags();
    },
    [syncFlags],
  );

  /** 异步填回完成后，把最近一条 fill_version 的 to 更新为终态（含 file_id / error）。 */
  const patchLatestFill = useCallback((artifactId: string, to: FillVersionSlice) => {
    const patch = (ops: DeskHistoryOp[]) => {
      for (let i = ops.length - 1; i >= 0; i -= 1) {
        const op = ops[i];
        if (op.type === "fill_version" && op.artifactId === artifactId) {
          const next = ops.slice();
          next[i] = { ...op, to };
          return next;
        }
      }
      return ops;
    };
    stacksRef.current = {
      past: patch(stacksRef.current.past),
      future: patch(stacksRef.current.future),
    };
  }, []);

  const undo = useCallback(() => {
    if (!projectId) return;
    const taken = takeUndo(stacksRef.current);
    if (!taken.op) return;
    stacksRef.current = taken.stacks;
    syncFlags();
    void enqueue(async () => {
      try {
        await applyInverse(projectId, taken.op!);
      } catch (error) {
        stacksRef.current = { past: [...stacksRef.current.past, taken.op!], future: stacksRef.current.future.filter((item) => item !== taken.op) };
        syncFlags();
        onError(`撤销失败：${error instanceof Error ? error.message : "未知错误"}`);
      }
      await refreshDesk(projectId).catch(() => undefined);
    });
  }, [projectId, enqueue, refreshDesk, onError, syncFlags]);

  const redo = useCallback(() => {
    if (!projectId) return;
    const taken = takeRedo(stacksRef.current);
    if (!taken.op) return;
    stacksRef.current = taken.stacks;
    syncFlags();
    void enqueue(async () => {
      try {
        await applyForward(projectId, taken.op!);
      } catch (error) {
        stacksRef.current = { past: stacksRef.current.past.filter((item) => item !== taken.op), future: [...stacksRef.current.future, taken.op!] };
        syncFlags();
        onError(`重做失败：${error instanceof Error ? error.message : "未知错误"}`);
      }
      await refreshDesk(projectId).catch(() => undefined);
    });
  }, [projectId, enqueue, refreshDesk, onError, syncFlags]);

  return { record, patchLatestFill, undo, redo, canUndo: flags.canUndo, canRedo: flags.canRedo };
}

export type DeskHistory = ReturnType<typeof useDeskHistory>;
export type SnapshotArtifact = ArtifactSnapshot;
