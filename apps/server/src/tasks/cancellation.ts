import type { BullMqQueueAdapter } from "./bullmq/queue.js";
import type { TaskStore } from "./task-store.js";

type CancellationQueue = Pick<BullMqQueueAdapter, "cancelJob">;

export class TaskCancellationService {
  constructor(
    private readonly store: TaskStore,
    private readonly queue: CancellationQueue,
  ) {}

  async cancelJob(taskId: string) {
    const task = await this.store.requestCancel(taskId);
    if (task?.status === "cancelled") await this.queue.cancelJob(task.id);
    return task;
  }

  async cancelProject(projectId: string) {
    const tasks = await this.store.requestCancelProject(projectId);
    await this.removeWaiting(tasks);
    return tasks.length;
  }

  async cancelThread(projectId: string, threadId: string) {
    const tasks = await this.store.requestCancelThread(projectId, threadId);
    await this.removeWaiting(tasks);
    return tasks.length;
  }

  async cancelArtifact(projectId: string, artifactId: string) {
    const tasks = await this.store.requestCancelArtifact(projectId, artifactId);
    await this.removeWaiting(tasks);
    return tasks.map((task) => task.id);
  }

  private async removeWaiting(tasks: Array<{ id: string; status: string }>) {
    for (const task of tasks) {
      if (task.status === "cancelled") await this.queue.cancelJob(task.id);
    }
  }
}
