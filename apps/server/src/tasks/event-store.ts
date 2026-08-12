import { and, asc, desc, eq, gt } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { taskEvents } from "../db/schema.js";

export type TaskEventRow = typeof taskEvents.$inferSelect;

export class TaskEventStore {
  constructor(private readonly db: Database) {}

  async append(input: {
    taskId: string;
    projectId: string;
    eventKey: string;
    type: string;
    payload?: unknown;
  }): Promise<TaskEventRow | undefined> {
    const [event] = await this.db.insert(taskEvents).values({
      taskId: input.taskId,
      projectId: input.projectId,
      eventKey: input.eventKey,
      type: input.type,
      payload: input.payload ?? {},
    }).onConflictDoNothing({ target: taskEvents.eventKey }).returning();
    return event;
  }

  async listAfter(projectId: string, afterId = 0, limit = 100): Promise<TaskEventRow[]> {
    const boundedLimit = Math.min(500, Math.max(1, Math.floor(limit)));
    return this.db.select().from(taskEvents)
      .where(and(eq(taskEvents.projectId, projectId), gt(taskEvents.id, afterId)))
      .orderBy(asc(taskEvents.id))
      .limit(boundedLimit);
  }

  async listGlobalAfter(afterId = 0, limit = 100): Promise<TaskEventRow[]> {
    const boundedLimit = Math.min(500, Math.max(1, Math.floor(limit)));
    return this.db.select().from(taskEvents)
      .where(gt(taskEvents.id, afterId))
      .orderBy(asc(taskEvents.id))
      .limit(boundedLimit);
  }

  /** 启动时跳过历史事件，只消费之后新写入的行。 */
  async latestId(): Promise<number> {
    const [maxRow] = await this.db.select({ id: taskEvents.id })
      .from(taskEvents)
      .orderBy(desc(taskEvents.id))
      .limit(1);
    return maxRow?.id ?? 0;
  }
}
