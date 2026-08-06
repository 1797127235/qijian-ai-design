import { useCallback, useRef, useState } from "react";
import { api, type DeskSnapshot } from "../lib/api";
import type { DeskHistory } from "./useDeskHistory";

/** 面板生图：不进 desk enqueue，按 source 互斥；完成后 refresh。 */
export function useDeskGenerate(options: {
  projectId?: string;
  history: DeskHistory;
  refreshDesk: (projectId: string) => Promise<DeskSnapshot>;
  onError: (message: string) => void;
}) {
  const { projectId, history, refreshDesk, onError } = options;
  const [busySourceId, setBusySourceId] = useState<string>();
  const [panelSourceId, setPanelSourceId] = useState<string>();
  const inflight = useRef(new Map<string, boolean>());

  const openPanel = useCallback((id: string) => setPanelSourceId(id), []);
  const closePanel = useCallback(() => setPanelSourceId(undefined), []);

  const generate = useCallback(
    async (sourceArtifactId: string, prompt: string) => {
      if (!projectId) return;
      if (inflight.current.get(sourceArtifactId)) return;
      inflight.current.set(sourceArtifactId, true);
      setBusySourceId(sourceArtifactId);
      const clientOpId = crypto.randomUUID();
      try {
        const result = await api.generateImage(projectId, { prompt, sourceArtifactId, clientOpId });
        const snap = await refreshDesk(projectId).catch(() => undefined);
        const artifact = snap?.artifacts.find((a) => a.id === result.artifact.id);
        const object = snap?.deskState.objects.find((o) => o.artifact_id === result.artifact.id);
        history.record({
          type: "generate",
          entry: {
            artifactId: result.artifact.id,
            artifactType: "effect_image",
            payload: artifact?.payload ?? { pending: true, prompt, source: "canvas_panel" },
            inputRefs: artifact?.inputRefs,
            layout: object
              ? { kind: object.kind, x: object.x, y: object.y, rot: object.rot, w: object.w }
              : { kind: "effect_image", x: 0, y: 0, rot: 0 },
          },
          connection: result.connection,
        });
        if (result.status === "failed") onError(`生成失败：${result.error ?? "未知错误"}`);
        setPanelSourceId(undefined);
      } catch (error) {
        onError(`生成失败：${error instanceof Error ? error.message : "未知错误"}`);
        await refreshDesk(projectId).catch(() => undefined);
      } finally {
        inflight.current.delete(sourceArtifactId);
        setBusySourceId(undefined);
      }
    },
    [projectId, history, refreshDesk, onError],
  );

  return { panelSourceId, busySourceId, openPanel, closePanel, generate };
}
