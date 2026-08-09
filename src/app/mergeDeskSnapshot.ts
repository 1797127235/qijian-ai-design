import type { DeskSnapshot } from "../lib/api";

/**
 * 合并 desk 刷新结果。
 * 默认保留本 tab 已加载的 viewport，避免 object_changed / 自回声 refetch 拽走镜头或回写视口。
 * 首屏（无 previous 或换项目）用服务端 viewport。
 */
export function mergeDeskSnapshot(
  incoming: DeskSnapshot,
  previous: DeskSnapshot | undefined,
  options?: { preserveViewport?: boolean },
): DeskSnapshot {
  const preserve = options?.preserveViewport !== false;
  if (preserve && previous?.project.id === incoming.project.id) {
    return {
      ...incoming,
      deskState: {
        ...incoming.deskState,
        viewport: previous.deskState.viewport,
      },
    };
  }
  return incoming;
}
