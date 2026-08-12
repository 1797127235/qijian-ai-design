/**
 * 项目封面服务：人看的桌面拼板 PNG（派生缓存）。
 *  - schedule：桌面实质变化后 8s 内存防抖，不阻塞任何 API
 *  - renderNow：revision 相同跳过；无 ready 像素保留旧封面；失败只上报不抛
 *  - 封面入 stored_files（projects.cover_file_id 指向），旧封面 best-effort 清扫
 *  - 与 agent 的 desk_overview 完全独立（renderer 走 style: "human"）
 */
import type { DeskSnapshot } from "../domain/types.js";
import { compileDeskObjects, revisionOf } from "../agent/desk-context.js";
import {
  OVERVIEW_MAX_TILES,
  renderDeskOverview,
  type OverviewRenderInput,
  type OverviewTileInput,
} from "./desk-overview-renderer.js";

export const COVER_FILENAME = "desk-cover.png";
export const COVER_MEDIA_TYPE = "image/png";
export const COVER_DEBOUNCE_MS = 8_000;

export type CoverRenderResult =
  | { rendered: true; fileId: string }
  | { rendered: false; reason: "revision_unchanged" | "no_ready_pixels" };

export type CoverRenderFn = (input: OverviewRenderInput) => Promise<{ png: Buffer; mimeType: typeof COVER_MEDIA_TYPE }>;

export type ProjectCoverDeps = {
  snapshot: (projectId: string) => Promise<DeskSnapshot>;
  getCover: (projectId: string) => Promise<{ fileId: string | null; revision: string | null }>;
  setCover: (projectId: string, fileId: string, revision: string) => Promise<void>;
  originalFilenames: (projectId: string, fileIds: string[]) => Promise<Record<string, string>>;
  /** 读图字节；文件不存在/读失败返回 null（该 tile 画灰块） */
  readImageBytes: (projectId: string, fileId: string) => Promise<Uint8Array | null>;
  putFile: (projectId: string, filename: string, mediaType: string, bytes: Uint8Array) => Promise<{ id: string }>;
  /** 旧封面清扫（best-effort；引用检查未过时可拒绝，不算失败） */
  deleteFile?: (projectId: string, fileId: string) => Promise<void>;
  render?: CoverRenderFn;
  maxTiles?: number;
  debounceMs?: number;
  onError?: (error: unknown, projectId: string) => void;
};

export class ProjectCoverService {
  private readonly render: CoverRenderFn;
  private readonly maxTiles: number;
  private readonly debounceMs: number;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: ProjectCoverDeps) {
    this.render = deps.render ?? (async (input) => renderDeskOverview(input));
    this.maxTiles = deps.maxTiles ?? OVERVIEW_MAX_TILES;
    this.debounceMs = deps.debounceMs ?? COVER_DEBOUNCE_MS;
  }

  /** 桌面实质变化后调用：防抖窗口内多次调用合并为一次渲染。 */
  schedule(projectId: string) {
    const existing = this.timers.get(projectId);
    if (existing) clearTimeout(existing);
    this.timers.set(
      projectId,
      setTimeout(() => {
        this.timers.delete(projectId);
        void this.renderNow(projectId).catch((error) => {
          this.deps.onError?.(error, projectId);
        });
      }, this.debounceMs),
    );
  }

  /** 取消待渲染（如项目删除时）。 */
  cancel(projectId: string) {
    const existing = this.timers.get(projectId);
    if (existing) clearTimeout(existing);
    this.timers.delete(projectId);
  }

  async renderNow(projectId: string): Promise<CoverRenderResult> {
    const snapshot = await this.deps.snapshot(projectId);
    const revision = revisionOf(snapshot);
    const cover = await this.deps.getCover(projectId);
    if (cover.revision === revision) return { rendered: false, reason: "revision_unchanged" };

    const fileIds = snapshot.artifacts
      .map((a) => (typeof a.payload.file_id === "string" ? a.payload.file_id : ""))
      .filter(Boolean);
    const fileNames = await this.deps.originalFilenames(projectId, fileIds).catch(() => ({}));
    const objects = compileDeskObjects(snapshot, fileNames);
    const layoutById = new Map(snapshot.deskState.objects.map((o) => [o.artifact_id, o]));

    const tiles: OverviewTileInput[] = [];
    for (const o of objects) {
      if (tiles.length >= this.maxTiles) break;
      const layout = layoutById.get(o.id);
      let imageBytes: Uint8Array | null = null;
      if (o.lifecycle === "ready" && o.fileId) {
        imageBytes = await this.deps.readImageBytes(projectId, o.fileId).catch(() => null);
      }
      tiles.push({
        id: o.id,
        alias: o.alias,
        label: o.label,
        lifecycle: o.lifecycle,
        x: layout?.x ?? o.x,
        y: layout?.y ?? o.y,
        w: layout?.w,
        imageBytes,
      });
    }

    // 一张真图都进不了拼板时保留旧封面（pending 灰块当封面没有信息量）
    const anyPixels = tiles.some((t) => t.imageBytes && t.imageBytes.byteLength > 0);
    if (!anyPixels) return { rendered: false, reason: "no_ready_pixels" };

    const rendered = await this.render({
      tiles,
      edges: (snapshot.deskState.connections ?? []).map((c) => ({ fromId: c.from, toId: c.to })),
      maxTiles: this.maxTiles,
      style: "human",
    });

    const stored = await this.deps.putFile(projectId, COVER_FILENAME, COVER_MEDIA_TYPE, rendered.png);
    await this.deps.setCover(projectId, stored.id, revision);
    if (cover.fileId && cover.fileId !== stored.id) {
      await this.deps.deleteFile?.(projectId, cover.fileId).catch(() => undefined);
    }
    return { rendered: true, fileId: stored.id };
  }
}
