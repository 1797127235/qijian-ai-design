/**
 * API 进程：消费 Worker 写入的 task.terminal，向 WebSocket 推 object_changed。
 *
 * Worker 在独立进程用 appendInTransaction 写图，不会触达 API 的 desk listener；
 * 前端仅在 object_changed 时 refreshDesk。本 poller 补上跨进程这一跳。
 */
import type { EventSink } from "../agent/events.js";
import type { TaskEventRow, TaskEventStore } from "./event-store.js";
import type { TaskStore } from "./task-store.js";

type EventReader = Pick<TaskEventStore, "listGlobalAfter">;
type TaskReader = Pick<TaskStore, "get">;

export class TaskDeskRefreshPoller {
  private cursor = 0;

  constructor(
    private readonly events: EventReader,
    private readonly tasks: TaskReader,
    private readonly publish: EventSink,
  ) {}

  async pollOnce(limit = 100): Promise<{ scanned: number; published: number; cursor: number }> {
    const rows = await this.events.listGlobalAfter(this.cursor, limit);
    let published = 0;
    for (const event of rows) {
      this.cursor = Math.max(this.cursor, event.id);
      if (event.type !== "task.terminal") continue;
      const task = await this.tasks.get(event.taskId);
      // 图像终态必刷新；命名写回也可能改 displayName（Worker 进程 listener 无效）
      if (!task) continue;
      if (task.taskRole !== "image" && task.taskRole !== "name") continue;
      this.publish({
        type: "object_changed",
        projectId: event.projectId,
        artifactId: task.artifactId ?? undefined,
      });
      published += 1;
    }
    return { scanned: rows.length, published, cursor: this.cursor };
  }

  restoreCursor(events: TaskEventRow[]): void {
    this.cursor = Math.max(this.cursor, ...events.map((event) => event.id), 0);
  }
}
