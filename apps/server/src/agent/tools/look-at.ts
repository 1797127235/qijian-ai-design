/**
 * look_at：按需细看指定物件原图。
 *  - ids：artifact UUID 或本轮桌面 alias（A01…）
 *  - 最多 MAX_INSPECT_IMAGES 张；成功图算 [INSPECT]
 *  - 0 张真图 → 整工具失败
 */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  compileDeskObjects,
  MAX_INSPECT_IMAGES,
  planInspectSelection,
  type DeskObjectView,
} from "../desk-context.js";
import { fail, type ToolContext } from "./shared.js";
import type { FileStorage } from "../../services/file-storage.js";

const ALIAS_RE = /^A\d{2,}$/i;

const parameters = Type.Object({
  ids: Type.Array(Type.String({ minLength: 1 }), {
    description: "要细看的 artifact id 或桌面 alias（A01…），最多 4 个",
    minItems: 1,
    maxItems: MAX_INSPECT_IMAGES,
  }),
});

type FilesDep = Pick<FileStorage, "getById" | "read" | "originalFilenames">;

function resolveToken(
  token: string,
  objects: DeskObjectView[],
): { artifactId: string } | { raw: string; missing: true } {
  const t = token.trim();
  if (!t) return { raw: token, missing: true };
  if (ALIAS_RE.test(t)) {
    const alias = t.toUpperCase();
    const o = objects.find((x) => x.alias === alias);
    if (o) return { artifactId: o.id };
    return { raw: t, missing: true };
  }
  return { artifactId: t };
}

export function createLookAtTool(ctx: ToolContext & { files: FilesDep }) {
  return defineTool({
    name: "look_at",
    label: "细看物件",
    description:
      "按 artifact id 或桌面编号 A01… 拉取最多 4 张 ready 原图，以工具结果附图返回。"
      + "返回的图算 [INSPECT]，可对列入 id 做材质/比例/细节判断。"
      + "未选中或需要细看非本轮选中物件时调用。pending/无图物件会跳过并说明原因；"
      + "若没有任何可附图则失败。",
    promptSnippet: "look_at — 按需细看指定物件原图（id 或 A0x，算 INSPECT）",
    promptGuidelines: [
      "未选中、或需细看非选中物件时调用 look_at（传 artifact id 或 A01…）。",
      "成功返回的图 role=inspect，与选中自动 Inspect 同权，可做材质/比例/细节判断。",
      "look_at_desk 总览不算 Inspect；细看用 look_at。",
      "一次最多 4 个 id；失败时如实说明，不要假装看过。",
    ],
    parameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      const tokens = (params.ids ?? []).map((s) => s.trim()).filter(Boolean);
      if (tokens.length === 0) {
        return fail("ids 不能为空", { reason: "empty_ids" });
      }

      try {
        if (signal?.aborted) return fail("已停止");

        const snapshot = await ctx.deps.desks.snapshot(ctx.projectId);
        const fileIds = snapshot.artifacts
          .map((a) => (typeof a.payload.file_id === "string" ? a.payload.file_id : ""))
          .filter(Boolean);
        const fileNames = await ctx.files.originalFilenames(ctx.projectId, fileIds).catch(() => ({}));
        const objects = compileDeskObjects(snapshot, fileNames);
        const byId = new Map(objects.map((o) => [o.id, o]));

        const orderedIds: string[] = [];
        const preSkipped: { id: string; reason: string }[] = [];
        const seen = new Set<string>();

        for (const token of tokens) {
          const resolved = resolveToken(token, objects);
          if ("missing" in resolved) {
            preSkipped.push({ id: resolved.raw, reason: "missing" });
            continue;
          }
          if (seen.has(resolved.artifactId)) continue;
          seen.add(resolved.artifactId);
          orderedIds.push(resolved.artifactId);
        }

        const plan = planInspectSelection(snapshot, orderedIds);
        const skipped = [
          ...preSkipped,
          ...plan.skipped.map((s) => ({ id: s.artifactId, reason: s.reason })),
        ];

        if (plan.included.length === 0) {
          const skipText = skipped.map((s) => `${s.id} ${s.reason}`).join("；") || "无有效 id";
          return fail(`无法细看：没有任何 ready 原图（${skipText}）`, {
            reason: "no_inspect_pixels",
            skipped,
          });
        }

        const content: Array<
          | { type: "text"; text: string }
          | { type: "image"; data: string; mimeType: string }
        > = [];
        const includedIds: string[] = [];
        const loadSkipped: { id: string; reason: string }[] = [];
        const indexLines: string[] = [];

        let imageIndex = 0;
        for (const item of plan.included) {
          if (signal?.aborted) return fail("已停止");
          const stored = await ctx.files.getById(item.fileId);
          if (!stored || stored.projectId !== ctx.projectId) {
            loadSkipped.push({ id: item.artifactId, reason: "empty" });
            continue;
          }
          let bytes: Buffer;
          try {
            bytes = await ctx.files.read(stored.objectKey);
          } catch {
            loadSkipped.push({ id: item.artifactId, reason: "empty" });
            continue;
          }
          if (!bytes || bytes.byteLength === 0) {
            loadSkipped.push({ id: item.artifactId, reason: "empty" });
            continue;
          }
          const mime = stored.mediaType === "image/jpeg" ? "image/jpeg" : "image/png";
          imageIndex += 1;
          content.push({
            type: "image",
            data: bytes.toString("base64"),
            mimeType: mime,
          });
          includedIds.push(item.artifactId);
          const obj = byId.get(item.artifactId);
          const alias = obj?.alias ?? "?";
          const label = obj?.label ?? "";
          indexLines.push(
            `- image_${imageIndex} = ${alias} ${item.artifactId}「${label}」 file=${item.fileId}`,
          );
        }

        const allSkipped = [...skipped, ...loadSkipped];
        if (includedIds.length === 0) {
          return fail("无法读取任何原图像素", {
            reason: "no_inspect_pixels",
            skipped: allSkipped,
          });
        }

        const skipLines = allSkipped.length
          ? `未附原图：${allSkipped.map((s) => `${s.id} ${s.reason}`).join("；")}`
          : "";

        const text = [
          "[INSPECT] look_at 工具结果（下列 id 已附原图像素，可做材质/比例/细节判断）：",
          ...indexLines,
          skipLines,
        ].filter(Boolean).join("\n");

        return {
          content: [{ type: "text" as const, text }, ...content],
          details: {
            ok: true as const,
            role: "inspect",
            included_ids: includedIds,
            skipped: allSkipped,
            image_count: includedIds.length,
          } as Record<string, unknown>,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "细看失败";
        return fail(message, { reason: "look_at_failed" });
      }
    },
  });
}
