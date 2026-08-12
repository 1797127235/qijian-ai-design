/**
 * remove_from_desk：从设计桌面删除物件（硬删 artifact + 布局 + 连线）。
 * 与 HTTP DELETE /desk/objects/:id 同一路径。
 */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { MAX_SELECTED_ARTIFACTS } from "../../domain/selection-limits.js";
import { compileDeskObjects, type DeskObjectView } from "../desk-context.js";
import { fail, ok, type ToolContext } from "./shared.js";

const ALIAS_RE = /^A\d{2,}$/i;

const parameters = Type.Object({
  artifact_ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
    description: "要删除的 artifact id 或桌面 alias（A01…）。省略时用本轮选中。",
    maxItems: MAX_SELECTED_ARTIFACTS,
  })),
});

/** 解析 id/alias 到桌面物件；不在桌面上则 missing。 */
function resolveOnDesk(
  token: string,
  objects: DeskObjectView[],
  onDesk: Set<string>,
): { ok: true; id: string; alias?: string } | { ok: false; token: string } {
  const t = token.trim();
  if (!t) return { ok: false, token };
  if (ALIAS_RE.test(t)) {
    const alias = t.toUpperCase();
    const o = objects.find((x) => x.alias === alias);
    if (o && onDesk.has(o.id)) return { ok: true, id: o.id, alias };
    return { ok: false, token: alias };
  }
  const o = objects.find((x) => x.id === t);
  if (o && onDesk.has(o.id)) return { ok: true, id: o.id, alias: o.alias };
  if (onDesk.has(t)) return { ok: true, id: t };
  return { ok: false, token: t };
}

export function createRemoveFromDeskTool(ctx: ToolContext) {
  return defineTool({
    name: "remove_from_desk",
    label: "删除桌面物件",
    description:
      "从设计桌面删除物件（硬删卡片与版本，并清掉相关连线）。"
      + "用于用户明确要求删掉/清掉某张失败卡、叠卡、不要的图。"
      + "传 artifact id 或 A01…；省略则删本轮选中。"
      + "不可恢复；不要批量清空整桌，除非用户明确要求。"
      + "进行中的生图会先取消再删。",
    promptSnippet: "remove_from_desk — 删除桌面物件（id 或 A0x）",
    promptGuidelines: [
      "用户明确要求删除/清掉某卡时调用 remove_from_desk。",
      "传 artifact id 或 A01…；省略则用本轮选中。",
      `一次最多 ${MAX_SELECTED_ARTIFACTS} 个；禁止未确认时清空整桌。`,
      "成功后才能说已删除；失败如实说明。",
      "删除不能代替「覆盖重生」；要改图用 replace_on_desk。",
    ],
    parameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) return fail("已停止");

      const snapshot = await ctx.deps.desks.snapshot(ctx.projectId);
      const objects = compileDeskObjects(snapshot, {});
      const onDesk = new Set(snapshot.deskState.objects.map((o) => o.artifact_id));

      const rawTokens = params.artifact_ids !== undefined
        ? params.artifact_ids.map((s) => s.trim()).filter(Boolean)
        : ctx.selectedArtifactIds().filter(Boolean);

      if (rawTokens.length === 0) {
        return fail("未指定要删除的物件：请传 artifact_ids，或先在画布上选中。", {
          reason: "empty_ids",
        });
      }
      if (rawTokens.length > MAX_SELECTED_ARTIFACTS) {
        return fail(`一次最多删除 ${MAX_SELECTED_ARTIFACTS} 个物件`, {
          reason: "too_many",
        });
      }

      const resolved: Array<{ id: string; alias?: string }> = [];
      const missing: string[] = [];
      for (const token of rawTokens) {
        const r = resolveOnDesk(token, objects, onDesk);
        if (!r.ok) {
          missing.push(r.token);
          continue;
        }
        if (!resolved.some((x) => x.id === r.id)) resolved.push({ id: r.id, alias: r.alias });
      }

      if (resolved.length === 0) {
        return fail(
          `没有可删除的桌面物件${missing.length ? `（未找到：${missing.join(", ")}）` : ""}`,
          { reason: "not_on_desk", missing },
        );
      }

      const deleted: Array<{ artifact_id: string; alias?: string }> = [];
      const failed: Array<{ artifact_id: string; error: string }> = [];
      const cancelledJobs: string[] = [];

      for (const item of resolved) {
        if (signal?.aborted) {
          return fail("已停止", {
            deleted,
            failed,
            cancelled_jobs: cancelledJobs,
          });
        }

        try {
          const cancelled = await ctx.deps.taskCancellation
            ?.cancelArtifact(ctx.projectId, item.id) ?? [];
          cancelledJobs.push(...cancelled);

          await ctx.deps.artifacts.deletePlaced(ctx.projectId, item.id);
          deleted.push({ artifact_id: item.id, alias: item.alias });
          ctx.changed(item.id, true);
        } catch (error) {
          failed.push({
            artifact_id: item.id,
            error: error instanceof Error ? error.message : "删除失败",
          });
        }
      }

      if (deleted.length === 0) {
        return fail(
          failed.map((f) => f.error).join("；") || "删除失败",
          { ok: false, failed, missing },
        );
      }

      const parts = [
        `已从桌面删除 ${deleted.length} 个物件：`
        + deleted.map((d) => d.alias ? `${d.alias}（${d.artifact_id}）` : d.artifact_id).join("、"),
      ];
      if (cancelledJobs.length) {
        parts.push(`已取消相关进行中生图 ${cancelledJobs.length} 个。`);
      }
      if (failed.length) {
        parts.push(`另有 ${failed.length} 个失败：${failed.map((f) => f.error).join("；")}`);
      }
      if (missing.length) {
        parts.push(`未找到：${missing.join(", ")}`);
      }

      return ok(parts.join(" "), {
        ok: true,
        deleted,
        failed,
        missing,
        cancelled_jobs: cancelledJobs,
      });
    },
  });
}
