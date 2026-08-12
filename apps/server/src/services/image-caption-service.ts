/**
 * 图片 caption 异步生成：读文件 → vision chat → sanitize → store.upsert。
 *  - kick() 完全 fire-and-forget，不堵对话
 *  - 单飞键：projectId + fileId + contentHash + analyzerVersion
 *  - 不使用 generate 的 artifact 互斥
 */
import type { ServerConfig } from "../config.js";
import {
  CAPTION_ANALYZER_VERSION,
  sanitizeCaptionText,
} from "./image-caption-sanitize.js";
import type { ImageCaptionStore } from "./image-caption-store.js";
import type { FileStorage } from "./file-storage.js";

const CAPTION_TIMEOUT_MS = 45_000;
/** 送入 vision 的 base64 上限（字符），过大则跳过本轮生成 */
const MAX_BASE64_CHARS = 1_500_000;

const SYSTEM_PROMPT =
  "你是室内设计图的画面观察助手。只根据图片写出可观察事实（空间类型、主要家具/材质、色调、构图要点）。"
  + "不超过80个中文字。不要风格空话，不要建议，不要角色扮演，不要输出除描述外的任何内容。";

export class ImageCaptionService {
  private readonly inflight = new Set<string>();

  constructor(
    private readonly files: FileStorage,
    private readonly store: ImageCaptionStore,
    private readonly config: ServerConfig,
  ) {}

  /**
   * 后台 kick：无 text LLM / 无 file 时静默跳过。
   * 已有 hit 或已在飞则跳过。
   */
  kick(projectId: string, fileId: string) {
    if (!fileId.trim()) return;
    if (!this.config.textEndpoint || !this.config.textApiKey) return;
    void this.run(projectId, fileId).catch(() => undefined);
  }

  /** 测试/运维：同步跑一次（仍受超时约束）。 */
  async generate(projectId: string, fileId: string): Promise<boolean> {
    return this.run(projectId, fileId);
  }

  private async run(projectId: string, fileId: string): Promise<boolean> {
    const stored = await this.files.getById(fileId);
    if (!stored || stored.projectId !== projectId) return false;
    if (!stored.mediaType.startsWith("image/")) return false;

    const contentHash = stored.contentHash;
    const analyzerVersion = CAPTION_ANALYZER_VERSION;
    const flightKey = `${projectId}\0${fileId}\0${contentHash}\0${analyzerVersion}`;
    if (this.inflight.has(flightKey)) return false;

    // 已有 hit 不重算
    const existing = await this.store.getMany(projectId, [
      { fileId, contentHash, analyzerVersion },
    ]);
    if (existing.has(fileId)) return true;

    this.inflight.add(flightKey);
    try {
      const bytes = new Uint8Array(await this.files.read(stored.objectKey));
      const b64 = Buffer.from(bytes).toString("base64");
      if (b64.length > MAX_BASE64_CHARS) return false;

      const raw = await this.callVision(stored.mediaType, b64);
      if (!raw) return false;
      const text = sanitizeCaptionText(raw);
      if (!text) return false;

      return await this.store.upsert({
        projectId,
        fileId,
        contentHash,
        analyzerVersion,
        text,
      });
    } finally {
      this.inflight.delete(flightKey);
    }
  }

  private async callVision(mediaType: string, base64: string): Promise<string | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CAPTION_TIMEOUT_MS);
    try {
      const response = await fetch(this.config.textEndpoint!, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.textApiKey}`,
        },
        body: JSON.stringify({
          model: this.config.textModel,
          temperature: 0.2,
          max_tokens: 120,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            {
              role: "user",
              content: [
                { type: "text", text: "请描述这张室内/空间设计图的可观察内容。" },
                {
                  type: "image_url",
                  image_url: { url: `data:${mediaType};base64,${base64}` },
                },
              ],
            },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) return undefined;
      const body = (await response.json()) as {
        choices?: { message?: { content?: unknown } }[];
      };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content === "string") return content;
      // 部分网关 content 为 parts 数组
      if (Array.isArray(content)) {
        const texts = content
          .map((part) => (part && typeof part === "object" && "text" in part
            ? String((part as { text?: unknown }).text ?? "")
            : ""))
          .filter(Boolean);
        return texts.join(" ") || undefined;
      }
      return undefined;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}
