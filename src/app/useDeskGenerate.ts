import { useCallback, useRef, useState } from "react";
import { api, type DeskSnapshot } from "../lib/api";
import type { DeskHistory } from "./useDeskHistory";

export interface GenerateOptions {
  /** 新建：源物件 id。重试时仍为参考源（连线 from）。 */
  sourceArtifactId: string;
  prompt: string;
  /** 重试：失败/草稿 effect_image 自身 id，在原卡上生成 */
  targetArtifactId?: string;
}

/** 面板生图：不进 desk enqueue；完成后 refresh。重试走 targetArtifactId。 */
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
    async (input: GenerateOptions | string, promptArg?: string) => {
      // 兼容旧调用 generate(sourceId, prompt)
      const opts: GenerateOptions = typeof input === "string"
        ? { sourceArtifactId: input, prompt: promptArg ?? "" }
        : input;
      if (!projectId) return;
      const lockKey = opts.targetArtifactId ?? opts.sourceArtifactId;
      if (inflight.current.get(lockKey)) return;
      inflight.current.set(lockKey, true);
      setBusySourceId(lockKey);
      const clientOpId = crypto.randomUUID();
      try {
        const result = await api.generateImage(projectId, {
          prompt: opts.prompt,
          sourceArtifactId: opts.sourceArtifactId,
          clientOpId,
          ...(opts.targetArtifactId ? { targetArtifactId: opts.targetArtifactId } : {}),
        });
        const snap = await refreshDesk(projectId).catch(() => undefined);
        const artifact = snap?.artifacts.find((a) => a.id === result.artifact.id);
        const object = snap?.deskState.objects.find((o) => o.artifact_id === result.artifact.id);
        // 重试不记新 history 条目（同一 artifact 版本前进）；新建才 record
        if (!opts.targetArtifactId) {
          history.record({
            type: "generate",
            entry: {
              artifactId: result.artifact.id,
              artifactType: "effect_image",
              payload: artifact?.payload ?? { pending: true, prompt: opts.prompt, source: "canvas_panel" },
              inputRefs: artifact?.inputRefs,
              layout: object
                ? { kind: object.kind, x: object.x, y: object.y, rot: object.rot, w: object.w }
                : { kind: "effect_image", x: 0, y: 0, rot: 0 },
            },
            connection: result.connection,
          });
        }
        if (result.status === "failed") onError(`生成失败：${result.error ?? "未知错误"}`);
        setPanelSourceId(undefined);
      } catch (error) {
        onError(`生成失败：${error instanceof Error ? error.message : "未知错误"}`);
        await refreshDesk(projectId).catch(() => undefined);
      } finally {
        inflight.current.delete(lockKey);
        setBusySourceId(undefined);
      }
    },
    [projectId, history, refreshDesk, onError],
  );

  return { panelSourceId, busySourceId, openPanel, closePanel, generate };
}
