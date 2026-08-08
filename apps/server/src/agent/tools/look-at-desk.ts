/**
 * look_at_desk：按需桌面总览拼图（路径 A：toolResult 内联 ImageContent）。
 *  - 无 ready 像素 → 整工具失败（无图）
 *  - 不算 Inspect；禁止材质/比例/验收
 *  - 超时 / 渲染失败 → fail
 */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  compileDeskObjects,
  revisionOf,
} from "../desk-context.js";
import {
  OVERVIEW_MAX_TILES,
  renderDeskOverview,
  type OverviewTileInput,
} from "../../services/desk-overview-renderer.js";
import { fail, type ToolContext } from "./shared.js";
import type { FileStorage } from "../../services/file-storage.js";

export const LOOK_AT_DESK_TIMEOUT_MS = 2_500;
export const LOOK_AT_DESK_MAX_BASE64 = 6 * 1024 * 1024;

const parameters = Type.Object({
  highlight_ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
    description: "要高亮的 artifact id；省略则用本轮画布选中",
    maxItems: 32,
  })),
  max_tiles: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: OVERVIEW_MAX_TILES,
    description: `最多拼入的物件数，默认 ${OVERVIEW_MAX_TILES}`,
  })),
});

type FilesDep = Pick<FileStorage, "getById" | "read" | "originalFilenames">;

export function createLookAtDeskTool(ctx: ToolContext & { files: FilesDep }) {
  return defineTool({
    name: "look_at_desk",
    label: "查看桌面总览",
    description:
      "生成一张当前桌面的缩略总览图（按布局排布、标 A01…、选中高亮、画连线），"
      + "以工具结果附图返回。用于理解整桌局面、编号对应、大致左右上下。"
      + "不能替代 [INSPECT] 做材质/比例/细节验收。"
      + "桌上没有任何 ready 图片时会失败。",
    promptSnippet: "look_at_desk — 按需桌面总览拼图（布局+alias）",
    promptGuidelines: [
      "需要整桌布局/谁在左上右下/多图编号对齐时调用 look_at_desk。",
      "闲聊或只谈已选中单张细看时不要调用。",
      "工具结果内的图 role=desk_overview，不算 [INSPECT]；禁止据此做材质/比例/验收断言。",
      "失败时如实说明，不要假装看过总览。",
    ],
    parameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      const maxTiles = params.max_tiles ?? OVERVIEW_MAX_TILES;
      const highlight = new Set(
        (params.highlight_ids?.length
          ? params.highlight_ids
          : ctx.selectedArtifactIds()
        ).map((id) => id.trim()).filter(Boolean),
      );

      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        if (signal?.aborted) return fail("已停止");

        const snapshot = await ctx.deps.desks.snapshot(ctx.projectId);
        const fileIds = snapshot.artifacts
          .map((a) => (typeof a.payload.file_id === "string" ? a.payload.file_id : ""))
          .filter(Boolean);
        const fileNames = await ctx.files.originalFilenames(ctx.projectId, fileIds).catch(() => ({}));
        const objects = compileDeskObjects(snapshot, fileNames);
        const ready = objects.filter((o) => o.lifecycle === "ready" && o.fileId);
        if (ready.length === 0) {
          return fail("桌面上没有可预览的 ready 图片，无法生成总览", {
            reason: "no_ready_pixels",
            object_count: objects.length,
          });
        }

        const layoutById = new Map(
          snapshot.deskState.objects.map((o) => [o.artifact_id, o]),
        );

        const work = (async () => {
          const tiles: OverviewTileInput[] = [];
          for (const o of objects) {
            if (tiles.length >= maxTiles) break;
            const layout = layoutById.get(o.id);
            let imageBytes: Buffer | null = null;
            if (o.lifecycle === "ready" && o.fileId) {
              const stored = await ctx.files.getById(o.fileId);
              if (stored && stored.projectId === ctx.projectId) {
                try {
                  imageBytes = await ctx.files.read(stored.objectKey);
                } catch {
                  imageBytes = null;
                }
              }
            }
            // 无真图像素的 tile 仍可灰块，但不计入「至少 1 张真图」——上面已保证有 ready
            tiles.push({
              id: o.id,
              alias: o.alias,
              label: o.label,
              lifecycle: o.lifecycle,
              x: layout?.x ?? o.x,
              y: layout?.y ?? o.y,
              w: layout?.w,
              imageBytes,
              highlighted: highlight.has(o.id),
            });
          }

          // 若截断后一张真图都没读到，整工具失败
          const anyPixels = tiles.some((t) => t.imageBytes && t.imageBytes.byteLength > 0);
          if (!anyPixels) {
            throw Object.assign(new Error("无法读取任何桌面图片字节"), { code: "no_pixels_loaded" });
          }

          const edges = (snapshot.deskState.connections ?? []).map((c) => ({
            fromId: c.from,
            toId: c.to,
          }));

          return renderDeskOverview({ tiles, edges, maxTiles });
        })();

        const rendered = await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(
              () => reject(Object.assign(new Error("总览渲染超时"), { code: "timeout" })),
              LOOK_AT_DESK_TIMEOUT_MS,
            );
            signal?.addEventListener("abort", () => {
              reject(Object.assign(new Error("已停止"), { code: "aborted" }));
            }, { once: true });
          }),
        ]);

        const data = rendered.png.toString("base64");
        if (data.length > LOOK_AT_DESK_MAX_BASE64) {
          return fail("总览图过大，已放弃注入", {
            reason: "over_bytes",
            base64_chars: data.length,
          });
        }

        const rev = revisionOf(snapshot);
        const aliasLines = objects
          .filter((o) => rendered.includedIds.includes(o.id))
          .map((o) => `${o.alias}=${o.id}「${o.label}」${o.lifecycle}${highlight.has(o.id) ? " ★" : ""}`)
          .join("；");
        const omitted = rendered.omittedIds.length
          ? `未入拼板 ${rendered.omittedIds.length} 件（已截断）。`
          : "";

        const text = [
          "[DESK_OVERVIEW] toolResult 内附 1 张图（role=desk_overview）。",
          "本图仅用于布局与 alias 对应，不算 [INSPECT]；禁止用于材质、比例或验收结论。",
          `revision=${rev} tiles=${rendered.tileCount} size=${rendered.width}x${rendered.height}`,
          aliasLines ? `拼板内：${aliasLines}` : "",
          omitted,
        ].filter(Boolean).join("\n");

        // details 为成功元数据；与 fail() 的 error 形态不同，用宽类型满足 defineTool 推断
        return {
          content: [
            { type: "text" as const, text },
            { type: "image" as const, data, mimeType: rendered.mimeType },
          ],
          details: {
            ok: true as const,
            role: "desk_overview",
            revision: rev,
            tile_count: rendered.tileCount,
            included_ids: rendered.includedIds,
            omitted_ids: rendered.omittedIds,
            width: rendered.width,
            height: rendered.height,
            base64_chars: data.length,
            highlighted_ids: [...highlight],
          } as Record<string, unknown>,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "总览生成失败";
        const code = error && typeof error === "object" && "code" in error
          ? String((error as { code: unknown }).code)
          : "render_failed";
        return fail(message, { reason: code });
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      }
    },
  });
}
