import { useEffect, useState } from "react";
import { api, type AiTask } from "./api";

export function useTaskPoll(
  task: AiTask | undefined,
  onSucceeded: (outputArtifactId: string) => Promise<void>,
  onFailed?: (message: string) => void,
) {
  const [current, setCurrent] = useState<AiTask | undefined>(task);

  useEffect(() => setCurrent(task), [task?.id, task?.status]);

  useEffect(() => {
    if (!current || !["pending", "running"].includes(current.status)) return;
    const timer = window.setInterval(async () => {
      try {
        const next = await api.task(current.id);
        setCurrent(next);
        if (next.status === "succeeded" && next.output_artifact_id) {
          await onSucceeded(next.output_artifact_id);
        }
        if (next.status === "failed") {
          onFailed?.(next.error_message || "生成失败，请重试。");
        }
      } catch (error) {
        onFailed?.(error instanceof Error ? error.message : "暂时无法读取任务状态。");
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [current?.id, current?.status]);

  return current;
}
