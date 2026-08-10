import type {
  GenerationOperation,
  GenerationOperationStore,
  GenerationOperationTransaction,
} from "../generation-operation-store.js";
import {
  classifyGenerateError,
  classifyTaskError,
  imageRetryBackoffMs,
} from "../state-machine.js";
import type { ImageGenerateTaskV1 } from "../types.js";

export class AmbiguousProviderResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmbiguousProviderResultError";
  }
}

export class GenerationOperationInProgressError extends Error {
  constructor(taskId: string) {
    super(`generation operation ${taskId} is already in progress`);
    this.name = "GenerationOperationInProgressError";
  }
}

export type GeneratedTaskAsset = {
  result: unknown;
  resultFileId?: string;
  providerRequestId?: string;
};

export interface ImageGenerateHandlerContext<T> {
  operations: GenerationOperationStore;
  targetArtifactId?: string;
  isCancellationRequested?: () => Promise<boolean>;
  generate(task: ImageGenerateTaskV1, operationId: string): Promise<GeneratedTaskAsset>;
  finalize(
    tx: GenerationOperationTransaction,
    task: ImageGenerateTaskV1,
    operation: GenerationOperation,
  ): Promise<T>;
  /** 含首次，默认 3 */
  maxAttempts?: number;
  /** 退避基数 ms，默认 2000 */
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type ImageGenerateHandlerResult<T> =
  | { status: "succeeded"; result: T; replayed: boolean; attempts?: number }
  | { status: "needs_review"; error: string }
  | { status: "cancelled" }
  | { status: "cancelled_with_side_effect"; result: unknown };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function handleImageGenerateTask<T>(
  task: ImageGenerateTaskV1,
  context: ImageGenerateHandlerContext<T>,
): Promise<ImageGenerateHandlerResult<T>> {
  const maxAttempts = Math.max(1, Math.min(8, Math.floor(context.maxAttempts ?? 3)));
  const backoffMs = Math.max(1, Math.floor(context.backoffMs ?? 2_000));
  const sleep = context.sleep ?? defaultSleep;

  let operation = await context.operations.ensure({
    taskId: task.task_id,
    projectId: task.project_id,
    operationKey: task.task_id,
    targetArtifactId: context.targetArtifactId ?? task.target_artifact_id,
    expectedTargetVersion: task.target_version,
  });

  if (operation.status === "needs_review") {
    return { status: "needs_review", error: operation.error ?? "provider result requires review" };
  }
  if (operation.status === "provider_pending") {
    return {
      status: "needs_review",
      error: "provider operation is still pending; do not retry generate without provider query",
    };
  }
  if (operation.status === "finalized" || operation.status === "downloaded") {
    if (operation.status === "downloaded" && await context.isCancellationRequested?.()) {
      return { status: "cancelled_with_side_effect", result: operation.result };
    }
    const finalized = await context.operations.finalize(
      task.task_id,
      (tx, current) => context.finalize(tx, task, current),
    );
    return {
      status: "succeeded",
      result: finalized.value,
      replayed: finalized.replayed,
      attempts: operation.attempt,
    };
  }

  let lastMessage = operation.error ?? "generation failed";

  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex++) {
    if (await context.isCancellationRequested?.()) {
      return { status: "cancelled" };
    }

    operation = await context.operations.get(task.task_id) ?? operation;

    if (operation.status === "failed") {
      const rearmed = await context.operations.rearmAfterFailedAttempt(task.task_id);
      if (!rearmed) {
        throw new Error(operation.error ?? "generation operation failed");
      }
      operation = rearmed;
    }

    if (operation.status !== "prepared") {
      if (operation.status === "needs_review") {
        return { status: "needs_review", error: operation.error ?? "provider result requires review" };
      }
      if (operation.status === "provider_pending") {
        return {
          status: "needs_review",
          error: "provider operation is still pending; do not retry generate without provider query",
        };
      }
      throw new Error(`generation operation cannot run from ${operation.status}`);
    }

    const claimed = await context.operations.beginProvider(task.task_id);
    if (!claimed) {
      return {
        status: "needs_review",
        error: "provider operation claim was lost; do not retry generate without provider query",
      };
    }
    operation = claimed;

    let generated: GeneratedTaskAsset;
    try {
      generated = await context.generate(task, operation.id);
    } catch (error) {
      if (error instanceof AmbiguousProviderResultError) {
        const message = error.message;
        await context.operations.markNeedsReview(task.task_id, message);
        return { status: "needs_review", error: message };
      }

      const classified = classifyGenerateError(error);
      lastMessage = classified.message;
      const decision = classifyTaskError(classified);
      await context.operations.markFailed(task.task_id, lastMessage);

      if (decision === "needs_review") {
        await context.operations.markNeedsReviewFromFailed(task.task_id, lastMessage);
        return { status: "needs_review", error: lastMessage };
      }

      if (decision === "retry" && attemptIndex + 1 < maxAttempts) {
        await sleep(imageRetryBackoffMs(attemptIndex, backoffMs));
        continue;
      }

      throw error instanceof Error ? error : new Error(lastMessage);
    }

    operation = await context.operations.recordDownloaded({
      taskId: task.task_id,
      result: generated.result,
      resultFileId: generated.resultFileId,
      providerRequestId: generated.providerRequestId,
    });
    if (await context.isCancellationRequested?.()) {
      return { status: "cancelled_with_side_effect", result: operation.result };
    }

    const finalized = await context.operations.finalize(
      task.task_id,
      (tx, current) => context.finalize(tx, task, current),
    );
    return {
      status: "succeeded",
      result: finalized.value,
      replayed: finalized.replayed,
      attempts: operation.attempt,
    };
  }

  throw new Error(lastMessage);
}
