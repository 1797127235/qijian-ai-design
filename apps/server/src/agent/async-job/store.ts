import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { agentJobs } from "../../db/schema.js";
import type { AgentJobDto, AgentJobStatus } from "./types.js";

function toDto(row: typeof agentJobs.$inferSelect): AgentJobDto {
  return {
    id: row.id,
    projectId: row.projectId,
    threadId: row.threadId,
    runId: row.runId ?? undefined,
    kind: row.kind,
    status: row.status,
    input: row.input,
    result: row.result ?? undefined,
    artifactId: row.artifactId ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString(),
    finishedAt: row.finishedAt?.toISOString(),
  };
}

export class AgentJobStore {
  constructor(private readonly db: Database) {}

  async create(input: {
    projectId: string;
    threadId: string;
    runId?: string;
    kind: string;
    input: unknown;
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

  async interruptStale(): Promise<number> {
    const rows = await this.db
      .update(agentJobs)
      .set({
        status: "interrupted",
        error: "服务重启或异常退出",
        finishedAt: new Date(),
      })
      .where(or(eq(agentJobs.status, "accepted"), eq(agentJobs.status, "running")))
      .returning({ id: agentJobs.id });
    return rows.length;
  }
}
