import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ProjectMemoryState } from "../lib/api";
import {
  DEFAULT_MEMORY_CARD_LAYOUT,
  loadMemoryCardLayout,
  saveMemoryCardLayout,
  type MemoryCardLayout,
} from "../desk/memory";

/**
 * 项目记忆 + 记忆卡布局（位置/隐藏，存 localStorage）。
 * chatBusy 从 true→false 时 refetch：助手在对话轮里写记忆，轮结束后卡片自刷新。
 */
export function useProjectMemory(projectId: string | undefined, chatBusy: boolean) {
  const [memory, setMemory] = useState<ProjectMemoryState>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [layout, setLayout] = useState<MemoryCardLayout>({ ...DEFAULT_MEMORY_CARD_LAYOUT });
  const prevBusy = useRef(chatBusy);

  const refresh = useCallback(() => {
    if (!projectId) return;
    api.projectMemory(projectId)
      .then((state) => {
        setMemory(state);
        setLoadFailed(false);
      })
      .catch(() => setLoadFailed(true));
  }, [projectId]);

  useEffect(() => {
    setMemory(undefined);
    setLoadFailed(false);
    setLayout(projectId ? loadMemoryCardLayout(projectId) : { ...DEFAULT_MEMORY_CARD_LAYOUT });
    refresh();
  }, [projectId, refresh]);

  useEffect(() => {
    if (prevBusy.current && !chatBusy) refresh();
    prevBusy.current = chatBusy;
  }, [chatBusy, refresh]);

  const updateLayout = useCallback(
    (next: MemoryCardLayout) => {
      setLayout(next);
      if (projectId) saveMemoryCardLayout(projectId, next);
    },
    [projectId],
  );

  return { memory, loadFailed, layout, updateLayout, refresh };
}
