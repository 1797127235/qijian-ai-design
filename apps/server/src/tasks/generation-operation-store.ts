import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { generationOperations } from "../db/schema.js";

export type GenerationOperation = typeof generationOperations.$inferSelect;
export type GenerationOperationTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export class GenerationOperationStore {
  constructor(private readonly db: Database) {}

  async ensure(input: {
    taskId: string;
    projectId: string;
    operationKey: string;
    targetArtifactId?: string;
    expectedTargetVersion: number;
  }): Promise<GenerationOperation> {
    const [created] = await this.db.insert(generationOperations).values({
      taskId: input.taskId,
      projectId: input.projectId,
      operationKey: input.operationKey,
      targetArtifactId: input.targetArtifactId,
      expectedTargetVersion: input.expectedTargetVersion,
    }).onConflictDoNothing({ target: generationOperations.taskId }).returning();
    if (created) return created;
    const existing = await this.get(input.taskId);
    if (!existing) throw new Error("generation operation conflict without an existing row");
    if (
      existing.operationKey !== input.operationKey
      || existing.projectId !== input.projectId
      || existing.targetArtifactId !== (input.targetArtifactId ?? null)
      || existing.expectedTargetVersion !== input.expectedTargetVersion
    ) {
      throw new Error("generation operation identity does not match the accepted task");
    }
    return existing;
  }

  async beginProvider(taskId: string): Promise<GenerationOperation | undefined> {
    const [row] = await this.db.update(generationOperations)
      .set({
        status: "provider_pending",
        attempt: sql`${generationOperations.attempt} + 1`,
        updatedAt: new Date(),
        error: null,
      })
      .where(and(
        eq(generationOperations.taskId, taskId),
        eq(generationOperations.status, "prepared"),
      ))
      .returning();
    return row;
  }

  async recordDownloaded(input: {
    taskId: string;
    result: unknown;
    resultFileId?: string;
    providerRequestId?: string;
  }): Promise<GenerationOperation> {
    const [row] = await this.db.update(generationOperations)
      .set({
        status: "downloaded",
        result: input.result,
        resultFileId: input.resultFileId,
        providerRequestId: input.providerRequestId,
        updatedAt: new Date(),
        error: null,
      })
      .where(and(
        eq(generationOperations.taskId, input.taskId),
        eq(generationOperations.status, "provider_pending"),
      ))
      .returning();
    if (row) return row;
    const existing = await this.get(input.taskId);
    if (existing?.status === "downloaded" || existing?.status === "finalized") return existing;
    throw new Error("generation operation is not awaiting a provider result");
  }

  async markNeedsReview(taskId: string, error: string): Promise<GenerationOperation | undefined> {
    const [row] = await this.db.update(generationOperations)
      .set({ status: "needs_review", error: error.slice(0, 2_000), updatedAt: new Date() })
      .where(and(
        eq(generationOperations.taskId, taskId),
        eq(generationOperations.status, "provider_pending"),
      ))
      .returning();
    return row;
  }

  /** provider 调用已失败落库后，升级为 needs_review（禁止 rearm 再 generate）。 */
  async markNeedsReviewFromFailed(taskId: string, error: string): Promise<GenerationOperation | undefined> {
    const [row] = await this.db.update(generationOperations)
      .set({ status: "needs_review", error: error.slice(0, 2_000), updatedAt: new Date() })
      .where(and(
        eq(generationOperations.taskId, taskId),
        eq(generationOperations.status, "failed"),
      ))
      .returning();
    return row;
  }

  async markFailed(taskId: string, error: string): Promise<GenerationOperation | undefined> {
    const [row] = await this.db.update(generationOperations)
      .set({ status: "failed", error: error.slice(0, 2_000), updatedAt: new Date() })
      .where(and(
        eq(generationOperations.taskId, taskId),
        eq(generationOperations.status, "provider_pending"),
      ))
      .returning();
    return row;
  }

  /**
   * 明确失败后允许同 task 再试：仅 `failed` → `prepared`。
   * 禁止从 needs_review / provider_pending rearm（ADR 0015）。
   */
  async rearmAfterFailedAttempt(taskId: string): Promise<GenerationOperation | undefined> {
    const [row] = await this.db.update(generationOperations)
      .set({
        status: "prepared",
        error: null,
        providerRequestId: null,
        resultFileId: null,
        result: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(generationOperations.taskId, taskId),
        eq(generationOperations.status, "failed"),
      ))
      .returning();
    return row;
  }

  async finalize<T>(
    taskId: string,
    apply: (tx: GenerationOperationTransaction, operation: GenerationOperation) => Promise<T>,
  ): Promise<{ value: T; replayed: boolean }> {
    return this.db.transaction(async (tx) => {
      const [operation] = await tx.select().from(generationOperations)
        .where(eq(generationOperations.taskId, taskId))
        .for("update");
      if (!operation) throw new Error("generation operation not found");
      if (operation.status === "finalized") {
        return { value: operation.result as T, replayed: true };
      }
      if (operation.status !== "downloaded") {
        throw new Error(`generation operation cannot finalize from ${operation.status}`);
      }
      const value = await apply(tx, operation);
      await tx.update(generationOperations).set({
        status: "finalized",
        result: value,
        updatedAt: new Date(),
        finalizedAt: new Date(),
        error: null,
      }).where(eq(generationOperations.id, operation.id));
      return { value, replayed: false };
    });
  }

  async get(taskId: string): Promise<GenerationOperation | undefined> {
    const [row] = await this.db.select().from(generationOperations)
      .where(eq(generationOperations.taskId, taskId));
    return row;
  }
}
