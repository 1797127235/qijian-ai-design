import { useCallback, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { api, type DeskSnapshot } from "../lib/api";
import type { ChatItem, DeskObject } from "../desk/types";
import { nextId } from "./ids";

export function useDeskActions(options: {
  projectId?: string;
  snapshot?: DeskSnapshot;
  activeProjectRef: MutableRefObject<string | undefined>;
  refreshDesk: (projectId: string) => Promise<DeskSnapshot>;
  setChatItems: Dispatch<SetStateAction<ChatItem[]>>;
  setObjects: Dispatch<SetStateAction<DeskObject[]>>;
}) {
  const { projectId, snapshot, activeProjectRef, refreshDesk, setChatItems, setObjects } = options;
  const [focusRequest, setFocusRequest] = useState<{ id: string; token: number }>();
  const persistViewport = useRef<number>();
  const viewportSaveFailed = useRef(false);
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());

  /** desk 变更串行化：防止 undo/移动/删除等异步操作乱序（codex async ordering 结论）。 */
  const enqueue = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const run = queueRef.current.then(task, task);
    queueRef.current = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }, []);

  const onMove = useCallback((id: string, x: number, y: number) => {
    setObjects((cur) => cur.map((o) => (o.id === id ? { ...o, x, y } : o)));
  }, [setObjects]);

  const onMoveEnd = useCallback(
    (id: string, _from: { x: number; y: number }, to: { x: number; y: number }) => {
      if (!projectId) return;
      void enqueue(() =>
        api.moveObject(projectId, id, { x: Math.round(to.x), y: Math.round(to.y) }).catch((e) => {
          if (activeProjectRef.current !== projectId) return;
          setChatItems((cur) => [...cur, { id: nextId(), role: "agent", text: `位置保存失败：${e instanceof Error ? e.message : "未知错误"}` }]);
          void refreshDesk(projectId).catch(() => undefined);
        }),
      );
    },
    [projectId, activeProjectRef, enqueue, refreshDesk, setChatItems],
  );

  const onViewportChange = useCallback(
    (viewport: { x: number; y: number; zoom: number }) => {
      if (!projectId || snapshot?.project.id !== projectId) return;
      window.clearTimeout(persistViewport.current);
      persistViewport.current = window.setTimeout(() => {
        void api
          .setViewport(projectId, viewport)
          .then(() => {
            viewportSaveFailed.current = false;
          })
          .catch((e) => {
            if (activeProjectRef.current !== projectId) return;
            if (!viewportSaveFailed.current) {
              setChatItems((cur) => [...cur, { id: nextId(), role: "agent", text: `视口保存失败：${e instanceof Error ? e.message : "未知错误"}` }]);
            }
            viewportSaveFailed.current = true;
            void refreshDesk(projectId).catch(() => undefined);
          });
      }, 800);
    },
    [projectId, refreshDesk, snapshot?.project.id, activeProjectRef, setChatItems],
  );

  const clearViewportTimer = useCallback(() => {
    window.clearTimeout(persistViewport.current);
    viewportSaveFailed.current = false;
  }, []);

  return {
    focusRequest,
    setFocusRequest,
    enqueue,
    onMove,
    onMoveEnd,
    onViewportChange,
    clearViewportTimer,
  };
}
