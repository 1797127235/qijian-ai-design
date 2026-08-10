/**
 * 生图工具共用执行核：model 校验 → ownedCurrent → BullMQ 持久任务受理。
 * 旁落 / 原卡替换 / 文生图只传不同 placement。
 */
import { MAX_SELECTED_ARTIFACTS } from "../../../../domain/selection-limits.js";
import { matchImageModelId } from "../../../../services/image-providers.js";
import { acceptedToolText } from "../../../async-job/protocol.js";
import { fail, ok, type ToolContext } from "../../shared.js";

/** Job kind 统一，靠 input.placement 区分；wake 白名单仍认 generate_from_desk。 */
export const DESK_GENERATE_JOB_KIND = "generate_from_desk";

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

export async function runDeskGenerate(ctx: ToolContext, input: RunDeskGenerateInput) {
  const prompt = input.prompt.trim();
  if (!prompt) return fail("prompt 不能为空");

  const modelResult = resolveImageModel(ctx, input.model);
  if (!modelResult.ok) return modelResult.error;
  const imageModel = modelResult.model;

  return runBullMqGenerate(ctx, input, imageModel);
}

async function runBullMqGenerate(
  ctx: ToolContext,
  input: RunDeskGenerateInput,
  imageModel: string | undefined,
) {
  const submitter = ctx.deps.assetTaskSubmitter;
  const session = ctx.session;
  if (!submitter || !session) return fail("异步任务服务未就绪");
  const ids = input.placement.mode === "spawn"
    ? input.placement.referenceArtifactIds
    : [input.placement.sourceArtifactId, ...input.placement.referenceArtifactIds];
  const ownedErr = await ensureOwned(ctx, ids, "源或参考物件无效");
  if (ownedErr) return ownedErr;
  if (input.signal?.aborted) return fail("已停止", { status: "failed" });

  try {
    const submitted = await submitter.submitAgentImage({
      projectId: ctx.projectId,
      threadId: session.threadId,
      runId: session.runId(),
      prompt: input.prompt.trim(),
      model: imageModel,
      toolName: input.toolName,
      toolCallId: input.toolCallId,
      placement: input.placement,
    });
    const details = {
      ok: true as const,
      async: true as const,
      status: "accepted" as const,
      task_id: submitted.taskId,
      kind: DESK_GENERATE_JOB_KIND,
      artifact_id: submitted.pending.artifact.id,
    };
    return ok(acceptedToolText(details), {
      ...details,
      task_kind: "image.generate",
      placement: input.placement.mode,
      tool: input.toolName,
      replace_in_place: input.placement.mode === "replace",
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "AbortError" || input.signal?.aborted)) {
      return fail("已停止生成", { status: "failed" });
    }
    return fail(error instanceof Error ? error.message : "生成失败");
  }
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
