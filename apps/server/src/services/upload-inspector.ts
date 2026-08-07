/**
 * 上传文件 inspector：在落盘前验证「内容 vs 声明类型」一致 + 读出关键元数据。
 *
 *  - JPEG/PNG：解析头部拿宽高；过大的直接拒（防 DOS / 防巨大图卡前端）
 *  - PDF：用 pdfjs-dist 拿 numPages；加密 PDF 单独提示
 *  - 任何声明类型与 magic bytes 不符都抛 422 INVALID_FILE_CONTENT
 */
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { AppError } from "../lib/errors.js";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, signature: number[]) {
  return signature.every((value, index) => bytes[index] === value);
}

/** 解析图片宽高（PNG: IHDR chunk；JPEG: 扫 SOFn marker）。失败返回 undefined。 */
function imageDimensions(bytes: Uint8Array, mediaType: string): { width: number; height: number } | undefined {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mediaType === "image/png") {
    if (!startsWith(bytes, PNG_SIGNATURE) || buffer.length < 24 || buffer.toString("ascii", 12, 16) !== "IHDR") return undefined;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mediaType !== "image/jpeg" || !startsWith(bytes, [0xff, 0xd8, 0xff])) return undefined;
  let offset = 2;
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > buffer.length) return undefined;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return undefined;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  return undefined;
}

/**
 * 上传前检查：
 *  - 拿到 pageCount（PDF）或校验尺寸（JPEG/PNG）
 *  - 像素数 > 80M 视为过大图，拒收
 *  - 加密 PDF 单独提示（让用户换格式）
 */
export async function inspectUpload(bytes: Uint8Array, mediaType: string): Promise<{ pageCount?: number }> {
  const dimensions = imageDimensions(bytes, mediaType);
  if (dimensions) {
    if (dimensions.width < 1 || dimensions.height < 1) {
      throw new AppError(422, "INVALID_FILE_CONTENT", "图片尺寸无效");
    }
    if (dimensions.width * dimensions.height > 80_000_000) {
      throw new AppError(422, "INVALID_FILE_CONTENT", "图片像素尺寸过大");
    }
    return {};
  }
  if (mediaType !== "application/pdf" || !startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    throw new AppError(422, "INVALID_FILE_CONTENT", "文件内容与声明的 PDF、JPG 或 PNG 类型不一致");
  }
  try {
    const loading = getDocument({ data: Uint8Array.from(bytes) });
    const document = await loading.promise;
    const pageCount = document.numPages;
    await loading.destroy();
    return { pageCount };
  } catch (error) {
    const message = error instanceof Error && /password/i.test(error.message) ? "暂不支持加密 PDF" : "PDF 文件损坏或无法读取";
    throw new AppError(422, "INVALID_FILE_CONTENT", message);
  }
}
