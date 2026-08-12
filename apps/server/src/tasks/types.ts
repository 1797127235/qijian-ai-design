import { z } from "zod";

const uuid = z.string().uuid();
const frozenArtifactRef = z.object({
  artifact_id: uuid,
  version_id: uuid,
  file_id: uuid,
}).strict();

export const generationMemorySnapshotSchema = z.object({
  checkpoint_revision: z.number().int().nonnegative(),
  stable_keys: z.array(z.string().min(1).max(300)).max(500).default([]),
  compiled_design_context: z.string().max(30_000),
}).strict();

export const imageGenerateTaskV1Schema = z.object({
  schema_version: z.literal(1),
  kind: z.literal("image.generate"),
  operation: z.enum(["beside", "replace", "spawn", "inpaint"]),
  project_id: uuid,
  task_id: uuid,
  source: frozenArtifactRef.optional(),
  references: z.array(frozenArtifactRef).max(8),
  target_artifact_id: uuid.optional(),
  target_version: z.number().int().nonnegative(),
  prompt: z.string().trim().min(1).max(8_000),
  user_prompt: z.string().trim().min(1).max(8_000).optional(),
  model: z.string().trim().min(1).max(200),
  size: z.string().trim().min(1).max(32).optional(),
  region: z.object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().positive().max(1),
    h: z.number().positive().max(1),
  }).strict().optional(),
  reference_file_id: uuid.optional(),
  origin: z.object({
    type: z.enum(["agent", "panel", "batch"]),
    name: z.string().trim().min(1).max(100),
  }).strict(),
  /** 受理时冻结的项目记忆快照。 */
  generation_memory: generationMemorySnapshotSchema.optional(),
}).strict().superRefine((task, ctx) => {
  if (task.operation !== "spawn" && !task.source) {
    ctx.addIssue({
      code: "custom",
      path: ["source"],
      message: `${task.operation} requires a frozen source`,
    });
  }
  if (task.operation === "inpaint" && !task.region) {
    ctx.addIssue({ code: "custom", path: ["region"], message: "inpaint requires a frozen region" });
  }
});

export const artifactNameTaskV1Schema = z.object({
  schema_version: z.literal(1),
  kind: z.literal("artifact.name"),
  project_id: uuid,
  task_id: uuid,
  artifact_id: uuid,
  artifact_version_id: uuid,
  name_version: z.number().int().nonnegative(),
  generation_token: z.string().trim().min(1).max(200),
  display_name_source: z.enum(["system", "model"]),
  naming_input: z.string().trim().min(1).max(8_000),
  force: z.boolean().optional(),
}).strict();

export const taskPayloadSchema = z.union([
  imageGenerateTaskV1Schema,
  artifactNameTaskV1Schema,
]);

export type ImageGenerateTaskV1 = z.infer<typeof imageGenerateTaskV1Schema>;
export type GenerationMemorySnapshot = z.infer<typeof generationMemorySnapshotSchema>;
export type ArtifactNameTaskV1 = z.infer<typeof artifactNameTaskV1Schema>;
export type TaskPayload = z.infer<typeof taskPayloadSchema>;

/**
 * 任务生命周期状态（PG agent_jobs.status）。
 * - enqueue_pending：事务已受理，尚未确认进 Redis
 * - accepted：已入队，等待 Worker
 * - running：Worker 已领取
 * - needs_review：外部 provider 结果不明，禁止盲目重试生图
 * - cancelled_with_side_effect：取消时已产生部分副作用（如下载完成）
 */
export type TaskStatus =
  | "enqueue_pending"
  | "accepted"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "cancelled_with_side_effect"
  | "needs_review";

/** Worker 见这些状态应停止执行，仅回放已有 result。 */
export const TERMINAL_TASK_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
  "cancelled_with_side_effect",
  "needs_review",
] as const satisfies readonly TaskStatus[];

export function isTerminalTaskStatus(status: string): status is (typeof TERMINAL_TASK_STATUSES)[number] {
  return (TERMINAL_TASK_STATUSES as readonly string[]).includes(status);
}

export type BatchStatus =
  | "accepted"
  | "running"
  | "succeeded"
  | "partial_failed"
  | "failed"
  | "cancelled"
  | "cancelled_with_side_effect";
