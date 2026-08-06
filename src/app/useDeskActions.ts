import { useCallback, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { api, type ArtifactSnapshot, type DeskSnapshot } from "../lib/api";
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

  const artifactOf = useCallback(
    (id: string): ArtifactSnapshot | undefined => snapshot?.artifacts.find((a) => a.id === id),
    [snapshot],
  );

  const onMove = useCallback((id: string, x: number, y: number) => {
    setObjects((cur) => cur.map((o) => (o.id === id ? { ...o, x, y } : o)));
  }, [setObjects]);

  const onMoveEnd = useCallback(
    (id: string, x: number, y: number) => {
      if (!projectId) return;
      void api.moveObject(projectId, id, { x: Math.round(x), y: Math.round(y) }).catch((e) => {
        if (activeProjectRef.current !== projectId) return;
        setChatItems((cur) => [...cur, { id: nextId(), role: "agent", text: `位置保存失败：${e instanceof Error ? e.message : "未知错误"}` }]);
        void refreshDesk(projectId).catch(() => undefined);
      });
    },
    [projectId, activeProjectRef, refreshDesk, setChatItems],
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

  const withRefresh = useCallback(
    async (fn: () => Promise<unknown>) => {
      if (!projectId) return false;
      try {
        await fn();
        await refreshDesk(projectId);
        return activeProjectRef.current === projectId;
      } catch (e) {
        setChatItems((cur) => [...cur, { id: nextId(), role: "agent", text: `操作失败：${e instanceof Error ? e.message : "未知错误"}` }]);
        return false;
      }
    },
    [projectId, refreshDesk, activeProjectRef, setChatItems],
  );

  const onConfirm = useCallback(
    async (artifactId: string) => {
      if (await withRefresh(() => api.confirmArtifact(artifactId))) {
        setFocusRequest({ id: artifactId, token: Date.now() });
      }
    },
    [withRefresh],
  );

  const onSelectDirection = useCallback(
    async (artifactId: string, directionId: string) => {
      const saved = await withRefresh(async () => {
        const artifact = artifactOf(artifactId);
        if (!artifact) return;
        await api.appendVersion(artifactId, { ...artifact.payload, selected_direction_id: directionId });
      });
      if (saved) setFocusRequest({ id: artifactId, token: Date.now() });
    },
    [artifactOf, withRefresh],
  );

  const onAdopt = useCallback(
    async (artifactId: string, adopted: boolean) => {
      const saved = await withRefresh(async () => {
        const artifact = artifactOf(artifactId);
        if (!artifact) return;
        await api.appendVersion(artifactId, { ...artifact.payload, adopted });
      });
      if (saved) setFocusRequest({ id: artifactId, token: Date.now() });
    },
    [artifactOf, withRefresh],
  );

  const clearViewportTimer = useCallback(() => {
    window.clearTimeout(persistViewport.current);
    viewportSaveFailed.current = false;
  }, []);

  return {
    focusRequest,
    setFocusRequest,
    artifactOf,
    onMove,
    onMoveEnd,
    onViewportChange,
    withRefresh,
    onConfirm,
    onSelectDirection,
    onAdopt,
    clearViewportTimer,
  };
}
