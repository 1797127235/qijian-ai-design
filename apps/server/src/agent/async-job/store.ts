/**
 * AgentJob 数据访问层。
 *  - 所有 status 转移都加 WHERE 状态守卫（inArray([oldStatuses])），并发 finalize 安全
 *  - listRecentForStatus 优先进行中 + 最近 1h 终态，给 prompt 状态栏用
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { agentJobs } from "../../db/schema.js";
import type { AgentJobDto } from "./types.js";

/** row → DTO（Date → ISO string）。 */
function toDto(row: typeof agentJobs.$inferSelect): AgentJobDto {
  return {
    id: row.id,
    projectId: row.projectId,
    threadId: row.threadId ?? undefined,
    runId: row.runId ?? undefined,
    kind: row.kind,
    status: row.status,
    input: row.input,
    result: row.result ?? undefined,
    artifactId: row.artifactId ?? undefined,
    error: row.error ?? undefined,
    traceContext: row.traceContext ?? undefined,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString(),
    finishedAt: row.finishedAt?.toISOString(),
  };
}

export class AgentJobStore {
  constructor(private readonly db: Database) {}

  async get(projectId: string, jobId: string): Promise<AgentJobDto | undefined> {
    const [row] = await this.db
      .select()
      .from(agentJobs)
      .where(and(eq(agentJobs.id, jobId), eq(agentJobs.projectId, projectId)));
    return row ? toDto(row) : undefined;
  }


  /** 状态栏：进行中优先，再近 1h 终态，最多 limit 条。 */
  async listRecentForStatus(projectId: string, limit = 5): Promise<AgentJobDto[]> {
    const active = await this.db
      .select()
      .from(agentJobs)
      .where(and(
        eq(agentJobs.projectId, projectId),
        inArray(agentJobs.status, ["enqueue_pending", "accepted", "running"]),
      ))
      .orderBy(desc(agentJobs.createdAt))
      .limit(limit);

    const remaining = Math.max(0, limit - active.length);
    if (remaining === 0) return active.map(toDto);

    const recentDone = await this.db
      .select()
      .from(agentJobs)
      .where(and(
        eq(agentJobs.projectId, projectId),
        inArray(agentJobs.status, [
          "succeeded",
          "failed",
          "cancelled",
          "cancelled_with_side_effect",
          "needs_review",
          "interrupted",
        ]),
        sql`${agentJobs.finishedAt} > now() - interval '1 hour'`,
      ))
      .orderBy(desc(agentJobs.finishedAt))
      .limit(remaining);

    return [...active, ...recentDone].map(toDto);
  }

}
