/**
 * AgentJob 数据访问层。
 *  - 所有 status 转移都加 WHERE 状态守卫（inArray([oldStatuses])），并发 finalize 安全
 *  - listRecentForStatus 优先进行中 + 最近 1h 终态，给 prompt 状态栏用
 */
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { agentJobs } from "../../db/schema.js";
import type { AgentJobDto, AgentJobStatus } from "./types.js";

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
    traceRootId: row.traceRootId ?? undefined,
    traceParentId: row.traceParentId ?? undefined,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString(),
    finishedAt: row.finishedAt?.toISOString(),
  };
}

export class AgentJobStore {
  constructor(private readonly db: Database) {}

  async create(input: {
    projectId: string;
    threadId?: string;
    runId?: string;
    kind: string;
    input: unknown;
    traceRootId?: string;
    traceParentId?: string;
  }): Promise<AgentJobDto> {
    const [row] = await this.db
      .insert(agentJobs)
      .values({
        projectId: input.projectId,
        threadId: input.threadId,
        runId: input.runId,
        kind: input.kind,
        status: "accepted",
        input: input.input,
        traceRootId: input.traceRootId,
        traceParentId: input.traceParentId,
      })
      .returning();
    return toDto(row);
  }

  async get(projectId: string, jobId: string): Promise<AgentJobDto | undefined> {
    const [row] = await this.db
      .select()
      .from(agentJobs)
      .where(and(eq(agentJobs.id, jobId), eq(agentJobs.projectId, projectId)));
    return row ? toDto(row) : undefined;
  }

  async setArtifact(jobId: string, artifactId: string): Promise<void> {
    await this.db.update(agentJobs).set({ artifactId }).where(eq(agentJobs.id, jobId));
  }

  async setTrace(jobId: string, trace: { traceRootId?: string; traceParentId?: string }): Promise<void> {
    await this.db.update(agentJobs).set({
      traceRootId: trace.traceRootId,
      traceParentId: trace.traceParentId,
    }).where(eq(agentJobs.id, jobId));
  }

  async listActiveByRun(runId: string): Promise<AgentJobDto[]> {
    const rows = await this.db
      .select()
      .from(agentJobs)
      .where(and(
        eq(agentJobs.runId, runId),
        inArray(agentJobs.status, ["accepted", "running"]),
      ));
    return rows.map(toDto);
  }

  /** boot：带 trace 的残留 job，用于 end 悬挂 Smith root。 */
  async listInterruptedWithTrace(limit = 100): Promise<AgentJobDto[]> {
    const rows = await this.db
      .select()
      .from(agentJobs)
      .where(and(
        inArray(agentJobs.status, ["interrupted"]),
        sql`${agentJobs.traceRootId} is not null`,
        sql`${agentJobs.finishedAt} > now() - interval '1 day'`,
      ))
      .orderBy(desc(agentJobs.finishedAt))
      .limit(limit);
    return rows.map(toDto);
  }

  async markRunning(jobId: string): Promise<void> {
    await this.db
      .update(agentJobs)
      .set({ status: "running", startedAt: new Date() })
      .where(and(eq(agentJobs.id, jobId), inArray(agentJobs.status, ["accepted", "running"])));
  }

  async finalize(
    jobId: string,
    status: Extract<AgentJobStatus, "succeeded" | "failed" | "cancelled" | "interrupted">,
    patch: { result?: unknown; error?: string; artifactId?: string } = {},
  ): Promise<AgentJobDto | undefined> {
    const [row] = await this.db
      .update(agentJobs)
      .set({
        status,
        result: patch.result,
        error: patch.error?.slice(0, 2_000),
        artifactId: patch.artifactId,
        finishedAt: new Date(),
      })
      .where(and(
        eq(agentJobs.id, jobId),
        inArray(agentJobs.status, ["accepted", "running"]),
      ))
      .returning();
    return row ? toDto(row) : undefined;
  }

  /** 状态栏：进行中优先，再近 1h 终态，最多 limit 条。 */
  async listRecentForStatus(projectId: string, limit = 5): Promise<AgentJobDto[]> {
    const active = await this.db
      .select()
      .from(agentJobs)
      .where(and(
        eq(agentJobs.projectId, projectId),
        inArray(agentJobs.status, ["accepted", "running"]),
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
        inArray(agentJobs.status, ["succeeded", "failed", "cancelled", "interrupted"]),
        sql`${agentJobs.finishedAt} > now() - interval '1 hour'`,
      ))
      .orderBy(desc(agentJobs.finishedAt))
      .limit(remaining);

    return [...active, ...recentDone].map(toDto);
  }

  async listActiveByProject(projectId: string): Promise<AgentJobDto[]> {
    const rows = await this.db
      .select()
      .from(agentJobs)
      .where(and(
        eq(agentJobs.projectId, projectId),
        inArray(agentJobs.status, ["accepted", "running"]),
      ));
    return rows.map(toDto);
  }

  /** Chat stop：仅当前 thread 的 active jobs（不杀面板 thread_id=null）。 */
  async listActiveByThread(projectId: string, threadId: string): Promise<AgentJobDto[]> {
    const rows = await this.db
      .select()
      .from(agentJobs)
      .where(and(
        eq(agentJobs.projectId, projectId),
        eq(agentJobs.threadId, threadId),
        inArray(agentJobs.status, ["accepted", "running"]),
      ));
    return rows.map(toDto);
  }

  /** 跨通道互斥：同 artifact 上仍进行中的 job。 */
  async listActiveByArtifact(projectId: string, artifactId: string): Promise<AgentJobDto[]> {
    const rows = await this.db
      .select()
      .from(agentJobs)
      .where(and(
        eq(agentJobs.projectId, projectId),
        eq(agentJobs.artifactId, artifactId),
        inArray(agentJobs.status, ["accepted", "running"]),
      ));
    return rows.map(toDto);
  }

  /** 启动清扫：把 accepted/running 全部标 interrupted（boot 唯一调用点）。 */
  async interruptStale(): Promise<AgentJobDto[]> {
    const rows = await this.db
      .update(agentJobs)
      .set({
        status: "interrupted",
        error: "服务重启或异常退出",
        finishedAt: new Date(),
      })
      .where(or(eq(agentJobs.status, "accepted"), eq(agentJobs.status, "running")))
      .returning();
    return rows.map(toDto);
  }
}
