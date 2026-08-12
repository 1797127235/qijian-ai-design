import { useCallback, useRef, useState } from "react";
import { api, type DeskSnapshot } from "../lib/api";
import type { createGenerateHistoryGate } from "./recordGenerateOnce";
import type { DeskHistory } from "./useDeskHistory";

export interface GenerateOptions {
  /** 新建：源物件 id。重试时仍为参考源（连线 from）。 */
  sourceArtifactId: string;
  prompt: string;
  /** 重试：失败/草稿 effect_image 自身 id，在原卡上生成 */
  targetArtifactId?: string;
  /**
   * 空占位填回：结果写回 target（通常 = source），记 fill_version 而非 generate。
   * previous* 为调用前快照，undo 写回。
   */
  fillBack?: boolean;
  previousPayload?: Record<string, unknown>;
  previousInputRefs?: unknown[];
  /** 局部重绘：归一化选区（0–1，源图本地坐标） */
  region?: { x: number; y: number; w: number; h: number };
  /** 局部重绘：用户上传的参考图 fileId */
  referenceFileId?: string;
  /** 出图尺寸：auto / 1:1 / 16:9 / WxH */
  size?: string;
  /** 生图 model */
  model?: string;
}

/** 面板生图：H8 秒级 accepted；终态靠 WS object_changed。 */
export function useDeskGenerate(options: {
  projectId?: string;
  history: DeskHistory;
  refreshDesk: (projectId: string) => Promise<DeskSnapshot>;
  onError: (message: string) => void;
  generateGate: ReturnType<typeof createGenerateHistoryGate>;
}) {
  const { projectId, history, refreshDesk, onError, generateGate } = options;
  const [busySourceId, setBusySourceId] = useState<string>();
  const [panelSourceId, setPanelSourceId] = useState<string>();
  const inflight = useRef(new Map<string, boolean>());

  const openPanel = useCallback((id: string) => setPanelSourceId(id), []);
  const closePanel = useCallback(() => setPanelSourceId(undefined), []);

  const generate = useCallback(
    async (input: GenerateOptions | string, promptArg?: string) => {
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
          targetArtifactId: opts.targetArtifactId,
          region: opts.region,
          referenceFileId: opts.referenceFileId,
          size: opts.size,
          model: opts.model,
        });
        const snap = await refreshDesk(projectId).catch(() => undefined);
        const artifact = snap?.artifacts.find((a) => a.id === result.artifact.id);
        const object = snap?.deskState.objects.find((o) => o.artifact_id === result.artifact.id);
        // 多参考 = 多条连线；API 只回 primary，以 desk 快照为准
        const edgeConnections = snap?.deskState.connections.filter((c) => c.to === result.artifact.id)
          ?? (result.connection ? [result.connection] : []);
        if (opts.fillBack && opts.targetArtifactId) {
          // 同卡填回：记版本前后，undo 恢复空白/旧内容（不删卡）
          history.record({
            type: "fill_version",
            artifactId: opts.targetArtifactId,
            from: {
              payload: opts.previousPayload ?? {},
              inputRefs: opts.previousInputRefs,
            },
            to: {
              payload: artifact?.payload ?? { pending: true, prompt: opts.prompt, source: "canvas_panel" },
              inputRefs: artifact?.inputRefs,
            },
          });
        } else if (!opts.targetArtifactId && edgeConnections.length > 0) {
          // 新建效果图；重试不记
          generateGate.tryRecord(
            result.artifact.id,
            history.record,
            {
              artifactId: result.artifact.id,
              artifactType: "effect_image",
              payload: artifact?.payload ?? { pending: true, prompt: opts.prompt, source: "canvas_panel" },
              inputRefs: artifact?.inputRefs,
              layout: object
                ? { kind: object.kind, x: object.x, y: object.y, rot: object.rot, w: object.w }
                : { kind: "effect_image", x: 0, y: 0, rot: 0 },
            },
            edgeConnections,
          );
        }
        setPanelSourceId(undefined);
      } catch (error) {
        onError(`生成失败：${error instanceof Error ? error.message : "未知错误"}`);
        await refreshDesk(projectId).catch(() => undefined);
      } finally {
        inflight.current.delete(lockKey);
        setBusySourceId(undefined);
      }
    },
    [projectId, history, refreshDesk, onError, generateGate],
  );

  return { panelSourceId, busySourceId, openPanel, closePanel, generate };
}
