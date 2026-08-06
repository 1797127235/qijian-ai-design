import { useCallback, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { api, type DeskSnapshot } from "../lib/api";
import { screenToWorld, type Viewport } from "../desk/geometry";
import { validateCanvasImageFile } from "../desk/attachments";
import type { DeskObject } from "../desk/types";
import type { DeskHistory, DeskHistoryEntry } from "./useDeskHistory";

/** 文字/图片落桌、删除、便签提交 —— 全部经串行队列执行并写入会话历史。 */
export function useDeskPlacement(options: {
  projectId?: string;
  snapshot?: DeskSnapshot;
  objects: DeskObject[];
  selectedId?: string;
  setSelectedId: Dispatch<SetStateAction<string | undefined>>;
  enqueue: <T>(task: () => Promise<T>) => Promise<T>;
  history: DeskHistory;
  refreshDesk: (projectId: string) => Promise<DeskSnapshot>;
  onError: (message: string) => void;
  viewportRef: MutableRefObject<Viewport>;
}) {
  const { projectId, snapshot, objects, selectedId, setSelectedId, enqueue, history, refreshDesk, onError, viewportRef } = options;
  const [editingId, setEditingId] = useState<string>();
  const cascadeRef = useRef(0);

  const nextPlacement = useCallback(() => {
    const view = viewportRef.current;
    const center = screenToWorld({ x: window.innerWidth * 0.42, y: window.innerHeight * 0.5 }, { x: 0, y: 0 }, view);
    const offset = (cascadeRef.current % 8) * 28;
    cascadeRef.current += 1;
    return { x: Math.round(center.x - 105 + offset), y: Math.round(center.y - 60 + offset) };
  }, [viewportRef]);

  const addStickyNote = useCallback(() => {
    if (!projectId) return;
    const { x, y } = nextPlacement();
    const clientOpId = crypto.randomUUID();
    void enqueue(async () => {
      try {
        const result = await api.createArtifact(projectId, {
          artifactType: "sticky_note",
          payload: { text: "" },
          clientOpId,
          layout: { kind: "sticky_note", x, y, rot: 0 },
        });
        history.record({
          type: "place",
          entry: { artifactId: result.artifact.id, artifactType: "sticky_note", payload: { text: "" }, layout: { kind: "sticky_note", x, y, rot: 0 } },
        });
        setSelectedId(result.artifact.id);
        setEditingId(result.artifact.id);
      } catch (error) {
        onError(`创建便签失败：${error instanceof Error ? error.message : "未知错误"}`);
      }
      await refreshDesk(projectId).catch(() => undefined);
    });
  }, [projectId, enqueue, history, nextPlacement, onError, refreshDesk, setSelectedId]);

  const addImageFiles = useCallback(
    (files: File[]) => {
      if (!projectId || files.length === 0) return;
      const accepted: File[] = [];
      for (const file of files) {
        const problem = validateCanvasImageFile(file);
        if (problem) onError(`${file.name}：${problem}`);
        else accepted.push(file);
      }
      if (accepted.length === 0) return;
      void enqueue(async () => {
        for (const file of accepted) {
          const { x, y } = nextPlacement();
          try {
            const stored = await api.uploadFile(projectId, file);
            const clientOpId = crypto.randomUUID();
            const result = await api.createArtifact(projectId, {
              artifactType: "canvas_image",
              payload: { file_id: stored.id },
              inputRefs: [{ file_id: stored.id }],
              clientOpId,
              layout: { kind: "canvas_image", x, y, rot: 0 },
            });
            history.record({
              type: "place",
              entry: {
                artifactId: result.artifact.id,
                artifactType: "canvas_image",
                payload: { file_id: stored.id },
                inputRefs: [{ file_id: stored.id }],
                layout: { kind: "canvas_image", x, y, rot: 0 },
              },
            });
          } catch (error) {
            onError(`图片落桌失败（${file.name}）：${error instanceof Error ? error.message : "未知错误"}`);
          }
        }
        await refreshDesk(projectId).catch(() => undefined);
      });
    },
    [projectId, enqueue, history, nextPlacement, onError, refreshDesk],
  );

  const entryFor = useCallback(
    (artifactId: string): DeskHistoryEntry | undefined => {
      const artifact = snapshot?.artifacts.find((item) => item.id === artifactId);
      const object = objects.find((item) => item.id === artifactId);
      if (!artifact || !object) return undefined;
      if (artifact.artifactType !== "sticky_note" && artifact.artifactType !== "canvas_image") return undefined;
      return {
        artifactId,
        artifactType: artifact.artifactType,
        payload: artifact.payload,
        inputRefs: artifact.inputRefs,
        layout: { kind: object.kind, x: object.x, y: object.y, rot: object.rot },
      };
    },
    [snapshot, objects],
  );

  const deleteObject = useCallback(
    (artifactId: string) => {
      if (!projectId) return;
      const entry = entryFor(artifactId);
      void enqueue(async () => {
        try {
          await api.deleteObject(projectId, artifactId);
          if (entry) history.record({ type: "remove", entry });
          setSelectedId((cur) => (cur === artifactId ? undefined : cur));
          setEditingId((cur) => (cur === artifactId ? undefined : cur));
        } catch (error) {
          onError(`删除失败：${error instanceof Error ? error.message : "未知错误"}`);
        }
        await refreshDesk(projectId).catch(() => undefined);
      });
    },
    [projectId, enqueue, entryFor, history, onError, refreshDesk, setSelectedId],
  );

  const deleteSelected = useCallback(() => {
    if (selectedId) deleteObject(selectedId);
  }, [selectedId, deleteObject]);

  const commitText = useCallback(
    (artifactId: string, text: string) => {
      setEditingId((cur) => (cur === artifactId ? undefined : cur));
      if (!projectId) return;
      const object = objects.find((item) => item.id === artifactId && item.kind === "sticky_note");
      if (!object || object.kind !== "sticky_note") return;
      const next = text;
      if (next.trim().length === 0) {
        deleteObject(artifactId);
        return;
      }
      if (next === object.text) return;
      void enqueue(async () => {
        try {
          await api.appendVersion(artifactId, { text: next });
          history.record({ type: "update_text", artifactId, from: object.text, to: next });
        } catch (error) {
          onError(`便签保存失败：${error instanceof Error ? error.message : "未知错误"}`);
        }
        await refreshDesk(projectId).catch(() => undefined);
      });
    },
    [projectId, objects, enqueue, history, onError, refreshDesk, deleteObject],
  );

  return {
    editingId,
    startEdit: setEditingId,
    addStickyNote,
    addImageFiles,
    deleteObject,
    deleteSelected,
    commitText,
  };
}
