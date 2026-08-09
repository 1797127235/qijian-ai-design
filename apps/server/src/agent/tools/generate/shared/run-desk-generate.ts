/**
 * 生图工具共用执行核：model 校验 → ownedCurrent → jobs.run → prepare/complete。
 * 旁落 / 原卡替换 / 文生图只传不同 placement；并发帽在 jobs.run(maxActive) 内串行 create。
 */
import { randomUUID } from "node:crypto";
import { MAX_SELECTED_ARTIFACTS } from "../../../../domain/selection-limits.js";
import type { PreparedGenerate } from "../../../../services/canvas-generate-service.js";
import { matchImageModelId } from "../../../../services/image-providers.js";
import { DeskGenerateCapError } from "../../../async-job/runner.js";
import { fail, ok, type ToolContext } from "../../shared.js";

/** Job kind 统一，靠 input.placement 区分；wake 白名单仍认 generate_from_desk。 */
export const DESK_GENERATE_JOB_KIND = "generate_from_desk";

/**
 * 同项目 Agent 写桌生图同时进行中的上限（accepted+running）。
 * 超限工具直接 fail，不静默排队。可用环境变量 AGENT_DESK_GENERATE_MAX_ACTIVE 覆盖。
 */
export const DEFAULT_AGENT_DESK_GENERATE_MAX_ACTIVE = 2;

export function agentDeskGenerateMaxActive(): number {
  const raw = process.env.AGENT_DESK_GENERATE_MAX_ACTIVE?.trim();
  if (!raw) return DEFAULT_AGENT_DESK_GENERATE_MAX_ACTIVE;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_AGENT_DESK_GENERATE_MAX_ACTIVE;
  return Math.min(20, Math.floor(n));
}

export type DeskGeneratePlacement =
  | { mode: "beside"; sourceArtifactId: string; referenceArtifactIds: string[] }
  | { mode: "replace"; sourceArtifactId: string; referenceArtifactIds: string[] }
  | { mode: "spawn"; referenceArtifactIds: string[]; x?: number; y?: number };

export type DeskGenerateToolName =
  | "generate_from_desk"
  | "replace_on_desk"
  | "text_to_image_on_desk";

export type RunDeskGenerateInput = {
  prompt: string;
  placement: DeskGeneratePlacement;
  model?: string;
  toolCallId: string;
  signal?: AbortSignal;
  toolName: DeskGenerateToolName;
};

function capFail(error: DeskGenerateCapError) {
  return fail(error.message, {
    reason: error.reason,
    active: error.active,
    max: error.max,
  });
}

function resolveImageModel(ctx: ToolContext, requested?: string) {
  const knownModels = ctx.deps.imageModelOptions ?? [];
  const modelMatch = matchImageModelId(requested, knownModels);
  if (modelMatch !== null) return { ok: true as const, model: modelMatch };
  const name = requested?.trim() || "";
  const available = knownModels.length > 0
    ? knownModels.join(", ")
    : "（当前未配置任何生图 model）";
  return {
    ok: false as const,
    error: fail(
      `未知生图 model：${name}。可用：${available}。请改用列表中的 id，勿静默使用默认引擎。`,
      { reason: "unknown_model", model: name, available_models: knownModels },
    ),
  };
}

async function ensureOwned(ctx: ToolContext, ids: string[], fallback = "源物件无效") {
  try {
    for (const id of ids) await ctx.ownedCurrent(id);
    return null;
  } catch (error) {
    return fail(error instanceof Error ? error.message : fallback);
  }
}

function throwIfGenerateFailed(result: { status: string; error?: string }) {
  if (result.status !== "failed") return;
  const err = new Error(result.error ?? "生成失败");
  (err as Error & { name: string }).name = /取消|超时/.test(result.error ?? "")
    ? "AbortError"
    : "GenerateFailed";
  throw err;
}

type JobsRun = NonNullable<ToolContext["deps"]["jobs"]>["run"];

async function runGenerateJob(
  ctx: ToolContext,
  args: {
    toolCallId: string;
    toolName: DeskGenerateToolName;
    placement: DeskGeneratePlacement["mode"];
    jobInput: Record<string, unknown>;
    prepare: () => Promise<PreparedGenerate>;
    replaceInPlace: boolean;
    failExtra?: Record<string, unknown>;
    signal?: AbortSignal;
  },
) {
  const jobs = ctx.deps.jobs;
  const session = ctx.session;
  if (!jobs || !session) return fail("异步任务服务未就绪");

  let prepared: PreparedGenerate | undefined;
  try {
    const { text, details } = await jobs.run({
      projectId: ctx.projectId,
      threadId: session.threadId,
      runId: session.runId(),
      toolCallId: args.toolCallId,
      kind: DESK_GENERATE_JOB_KIND,
      maxActive: { kind: DESK_GENERATE_JOB_KIND, max: agentDeskGenerateMaxActive() },
      input: args.jobInput,
      prepare: async () => {
        prepared = await args.prepare();
        return { artifactId: prepared.pending.artifact.id };
      },
      work: async ({ signal: jobSignal }) => {
        if (!prepared) throw new Error("内部错误：prepare 未完成");
        const result = await ctx.deps.generate.complete(prepared, jobSignal);
        throwIfGenerateFailed(result);
        return {
          artifactId: result.artifact.id,
          result: {
            artifact_id: result.artifact.id,
            status: result.status,
            connection_id: result.connection?.id,
            placement: args.placement,
            tool: args.toolName,
          },
        };
      },
    } as Parameters<JobsRun>[0]);
    return ok(text, {
      ...details,
      placement: args.placement,
      tool: args.toolName,
      replace_in_place: args.replaceInPlace,
    });
  } catch (error) {
    if (error instanceof DeskGenerateCapError) return capFail(error);
    if (error instanceof Error && (error.name === "AbortError" || args.signal?.aborted)) {
      return fail("已停止生成", { status: "failed", ...args.failExtra });
    }
    return fail(error instanceof Error ? error.message : "生成失败", args.failExtra);
  }
}

export async function runDeskGenerate(ctx: ToolContext, input: RunDeskGenerateInput) {
  const prompt = input.prompt.trim();
  if (!prompt) return fail("prompt 不能为空");

  const modelResult = resolveImageModel(ctx, input.model);
  if (!modelResult.ok) return modelResult.error;
  const imageModel = modelResult.model;

  if (input.placement.mode === "spawn") {
    return runSpawnGenerate(ctx, {
      prompt,
      referenceArtifactIds: input.placement.referenceArtifactIds,
      x: input.placement.x,
      y: input.placement.y,
      imageModel,
      toolCallId: input.toolCallId,
      signal: input.signal,
      toolName: input.toolName,
    });
  }

  const sourceId = input.placement.sourceArtifactId;
  const referenceArtifactIds = input.placement.referenceArtifactIds;
  const replaceInPlace = input.placement.mode === "replace";
  const targetArtifactId = replaceInPlace ? sourceId : undefined;

  const ownedErr = await ensureOwned(ctx, [sourceId, ...referenceArtifactIds]);
  if (ownedErr) return ownedErr;
  if (input.signal?.aborted) {
    return fail("已停止", { source_artifact_id: sourceId, status: "failed" });
  }

  const clientOpId = `agent:${input.toolCallId || randomUUID()}`;
  return runGenerateJob(ctx, {
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    placement: input.placement.mode,
    replaceInPlace,
    signal: input.signal,
    failExtra: { source_artifact_id: sourceId },
    jobInput: {
      origin: "agent_chat",
      tool: input.toolName,
      placement: input.placement.mode,
      prompt,
      source_artifact_id: sourceId,
      ...(targetArtifactId
        ? { target_artifact_id: targetArtifactId, replace_in_place: true }
        : {}),
      reference_artifact_ids: referenceArtifactIds,
      client_op_id: clientOpId,
      ...(imageModel ? { model: imageModel } : {}),
    },
    prepare: () => ctx.deps.generate.prepare({
      projectId: ctx.projectId,
      sourceArtifactId: sourceId,
      prompt,
      clientOpId,
      referenceArtifactIds,
      source: "agent_chat",
      createdBy: "agent",
      ...(targetArtifactId ? { targetArtifactId } : {}),
      ...(imageModel ? { model: imageModel } : {}),
    }),
  });
}

async function runSpawnGenerate(
  ctx: ToolContext,
  input: {
    prompt: string;
    referenceArtifactIds: string[];
    x?: number;
    y?: number;
    imageModel: string | undefined;
    toolCallId: string;
    signal?: AbortSignal;
    toolName: DeskGenerateToolName;
  },
) {
  const ownedErr = await ensureOwned(ctx, input.referenceArtifactIds, "参考物件无效");
  if (ownedErr) return ownedErr;
  if (input.signal?.aborted) {
    return fail("已停止", { status: "failed", placement: "spawn" });
  }

  const clientOpId = `agent:${input.toolCallId || randomUUID()}`;
  const spawnAt =
    Number.isFinite(input.x) && Number.isFinite(input.y)
      ? { x: input.x as number, y: input.y as number }
      : undefined;

  return runGenerateJob(ctx, {
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    placement: "spawn",
    replaceInPlace: false,
    signal: input.signal,
    failExtra: { placement: "spawn" },
    jobInput: {
      origin: "agent_chat",
      tool: input.toolName,
      placement: "spawn",
      prompt: input.prompt,
      reference_artifact_ids: input.referenceArtifactIds,
      client_op_id: clientOpId,
      ...(spawnAt ? { spawn_at: spawnAt } : {}),
      ...(input.imageModel ? { model: input.imageModel } : {}),
    },
    prepare: () => ctx.deps.generate.prepare({
      projectId: ctx.projectId,
      prompt: input.prompt,
      clientOpId,
      referenceArtifactIds: input.referenceArtifactIds,
      source: "agent_chat",
      createdBy: "agent",
      ...(spawnAt ? { spawnAt } : {}),
      ...(input.imageModel ? { model: input.imageModel } : {}),
    }),
  });
}

/** 解析主源：显式 id > 单选；多选无显式则失败。 */
export function resolveSourceArtifactId(
  ctx: ToolContext,
  explicitSource?: string,
): { ok: true; sourceId: string } | { ok: false; error: string } {
  const selected = ctx.selectedArtifactIds().filter(Boolean);
  const sourceId = explicitSource?.trim() || "";
  if (sourceId) return { ok: true, sourceId };
  if (selected.length === 1) return { ok: true, sourceId: selected[0] };
  if (selected.length > 1) {
    return { ok: false, error: "多选时请指定主图 source_artifact_id（要改的那张场景图）。" };
  }
  return { ok: false, error: "未指定源物件：请用户先在画布上点选一张图，或传入 source_artifact_id。" };
}

/** 参考列表：显式参数优先，否则选中减去主源。 */
export function resolveReferenceArtifactIds(
  ctx: ToolContext,
  sourceId: string,
  referenceArtifactIds: string[] | undefined,
  hasExplicitRefs: boolean,
): { ok: true; ids: string[] } | { ok: false; error: string } {
  const selected = ctx.selectedArtifactIds().filter(Boolean);
  const refsFromParams = (referenceArtifactIds ?? []).map((id) => id.trim()).filter(Boolean);
  const refsFromSelection = selected.filter((id) => id !== sourceId);
  if (hasExplicitRefs && refsFromParams.length > MAX_SELECTED_ARTIFACTS) {
    return { ok: false, error: `参考物件不能超过 ${MAX_SELECTED_ARTIFACTS} 个` };
  }
  const ids = [...new Set(hasExplicitRefs ? refsFromParams : refsFromSelection)]
    .filter((id) => id !== sourceId)
    .slice(0, MAX_SELECTED_ARTIFACTS);
  return { ok: true, ids };
}

/** 文生图参考：仅显式参数；不把「选中」当主源。 */
export function resolveSpawnReferenceArtifactIds(
  referenceArtifactIds: string[] | undefined,
): { ok: true; ids: string[] } | { ok: false; error: string } {
  const ids = [...new Set((referenceArtifactIds ?? []).map((id) => id.trim()).filter(Boolean))];
  if (ids.length > MAX_SELECTED_ARTIFACTS) {
    return { ok: false, error: `参考物件不能超过 ${MAX_SELECTED_ARTIFACTS} 个` };
  }
  return { ok: true, ids };
}
