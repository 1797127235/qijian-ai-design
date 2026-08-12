import type { JobWakeService } from "../agent/async-job/job-wake.js";
import type { AgentJobStore } from "../agent/async-job/store.js";
import type { TaskEventRow, TaskEventStore } from "./event-store.js";

type EventReader = Pick<TaskEventStore, "listGlobalAfter">;
type JobReader = Pick<AgentJobStore, "get">;
type WakeSink = Pick<JobWakeService, "onJobTerminal">;
type TerminalObserver = (job: Awaited<ReturnType<JobReader["get"]>> & {}) => void;

export class TaskJobWakePoller {
  private cursor = 0;

  constructor(
    private readonly events: EventReader,
    private readonly jobs: JobReader,
    private readonly wake: WakeSink,
    private readonly onTerminal?: TerminalObserver,
  ) {}

  async pollOnce(limit = 100): Promise<{ scanned: number; terminal: number; cursor: number }> {
    const rows = await this.events.listGlobalAfter(this.cursor, limit);
    let terminal = 0;
    for (const event of rows) {
      this.cursor = Math.max(this.cursor, event.id);
      if (event.type !== "task.terminal") continue;
      const job = await this.jobs.get(event.projectId, event.taskId);
      if (!job) continue;
      this.onTerminal?.(job);
      this.wake.onJobTerminal(job);
      terminal += 1;
    }
    return { scanned: rows.length, terminal, cursor: this.cursor };
  }

  restoreCursor(events: TaskEventRow[]): void {
    this.cursor = Math.max(this.cursor, ...events.map((event) => event.id), 0);
  }
}
