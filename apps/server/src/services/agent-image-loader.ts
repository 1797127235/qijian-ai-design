import { createCanvas } from "@napi-rs/canvas";
import { and, eq, inArray } from "drizzle-orm";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { Database } from "../db/client.js";
import { storedFiles } from "../db/schema.js";
import { AppError } from "../lib/errors.js";

export interface VisualAttachment {
  id: string;
  originalFilename: string;
  mediaType: string;
  pageCount?: number;
}

export interface AgentImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

const MAX_PDF_PAGES_FOR_AGENT = 8;
const MAX_RENDER_EDGE = 1_600;
const MAX_AGENT_IMAGES = 12;
const MAX_AGENT_BASE64_CHARACTERS = 24 * 1024 * 1024;

/**
 * 把用户的附件转换成 Agent 视觉输入。
 *  - JPEG/PNG：直接读盘 → base64（保持原 mimeType）
 *  - PDF：用 @napi-rs/canvas + pdfjs 把每页渲染成 PNG → base64
 *  - 限额：最多 8 页、12 张图、24MB base64 字符（防 LLM 上下文爆掉）
 */
export async function loadAgentImages(
  db: Database,
  readBytes: (objectKey: string) => Promise<Buffer>,
  projectId: string,
  attachments: VisualAttachment[],
): Promise<AgentImageContent[]> {
  if (attachments.length === 0) return [];
  const rows = await db
    .select()
    .from(storedFiles)
    .where(and(eq(storedFiles.projectId, projectId), inArray(storedFiles.id, attachments.map((item) => item.id))));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const images: AgentImageContent[] = [];
  for (const attachment of attachments) {
    const stored = byId.get(attachment.id);
    if (!stored) throw new AppError(404, "ATTACHMENT_NOT_FOUND", `附件不存在：${attachment.originalFilename}`);
    const bytes = await readBytes(stored.objectKey);
    if (stored.mediaType === "image/jpeg" || stored.mediaType === "image/png") {
      images.push({ type: "image", data: bytes.toString("base64"), mimeType: stored.mediaType });
    } else {
      const remainingPages = MAX_AGENT_IMAGES - images.length;
      if (remainingPages < Math.min(stored.pageCount ?? MAX_PDF_PAGES_FOR_AGENT, MAX_PDF_PAGES_FOR_AGENT)) {
        throw new AppError(422, "VALIDATION_FAILED", "附件视觉内容超过模型处理上限，请减少文件或 PDF 页数");
      }
      images.push(...await renderPdf(bytes, stored.pageCount ?? undefined, remainingPages));
    }
    if (images.length > MAX_AGENT_IMAGES || images.reduce((total, image) => total + image.data.length, 0) > MAX_AGENT_BASE64_CHARACTERS) {
      throw new AppError(422, "VALIDATION_FAILED", "附件视觉内容超过模型处理上限，请减少文件或 PDF 页数");
    }
  }
  return images;
}

/**
 * PDF → PNG 列表：自动按最长边 1600px 缩放（保留比例），用 @napi-rs/canvas 后端渲染。
 * 缩放是为了给 LLM 的多模态 token 留出预算，同时保护画布图片不会糊。
 */
async function renderPdf(bytes: Uint8Array, knownPageCount?: number, remainingPages = MAX_PDF_PAGES_FOR_AGENT): Promise<AgentImageContent[]> {
  const loading = getDocument({ data: Uint8Array.from(bytes) });
  const document = await loading.promise;
  try {
    const pageCount = Math.min(knownPageCount ?? document.numPages, MAX_PDF_PAGES_FOR_AGENT, Math.max(0, remainingPages));
    const images: AgentImageContent[] = [];
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const natural = page.getViewport({ scale: 1 });
      const scale = Math.min(2, MAX_RENDER_EDGE / Math.max(natural.width, natural.height));
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
      const context = canvas.getContext("2d");
      await page.render({ canvas: canvas as never, canvasContext: context as never, viewport }).promise;
      images.push({ type: "image", data: canvas.toBuffer("image/png").toString("base64"), mimeType: "image/png" });
      page.cleanup();
    }
    return images;
  } finally {
    await loading.destroy();
  }
}
