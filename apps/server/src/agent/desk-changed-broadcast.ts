import type { EventSink } from "./events.js";

/**
 * 桌面实质变化：封面防抖重渲 + 跨 tab `object_changed`（无 artifactId，避免他 tab 抢焦点）。
 * Agent/Job 路径仍可单独带 artifactId 再发一次。
 */
export function createDeskContentChangedHandler(
  scheduleCover: (projectId: string) => void,
  publish: EventSink,
): (projectId: string) => void {
  return (projectId) => {
    scheduleCover(projectId);
    publish({ type: "object_changed", projectId });
  };
}
