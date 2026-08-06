import type { ServerConfig } from "../config.js";
import { HttpError } from "../lib/errors.js";
import type { FileStorage } from "./file-storage.js";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const imageExtensions = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
]);

function hasImageSignature(mediaType: string, bytes: Uint8Array) {
  if (mediaType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mediaType === "image/png") {
    return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  }
  if (mediaType === "image/webp") {
    return bytes.length >= 12
      && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
      && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  }
  return false;
}

export interface ReferenceFile {
  mediaType: string;
  bytes: Uint8Array;
  filename?: string;
}

export interface GenerateImageInput {
  projectId: string;
  intent?: string;
  context: string;
  referenceFiles?: ReferenceFile[];
}

export interface GeneratedImage {
  url: string;
  fileId: string;
  sourceUrl: string;
  providerId?: string;
}

export interface ImageGenerator {
  generate(input: GenerateImageInput, signal?: AbortSignal): Promise<GeneratedImage>;
}

export class HttpImageGenerator implements ImageGenerator {
  constructor(
    private readonly config: ServerConfig,
    private readonly files: FileStorage,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async generate(input: GenerateImageInput, signal?: AbortSignal): Promise<GeneratedImage> {
    if (!this.config.imageEndpoint || !this.config.imageApiKey) {
      throw new HttpError(503, "尚未配置 IMAGE_API_URL 和 IMAGE_API_KEY，无法生成效果图");
    }
    const prompt = `${input.context}\n补充意图：${input.intent ?? "无"}`;
    const refs = input.referenceFiles ?? [];
    const response = refs.length > 0
      ? await this.requestWithReferences(prompt, refs, signal)
      : await this.requestTextOnly(prompt, signal);
    if (!response.ok) throw new HttpError(503, `图像服务调用失败：${response.status}`);
    const body = (await response.json()) as {
      data?: Array<{ url?: string; b64_json?: string; id?: string }>;
      url?: string;
      id?: string;
      images?: Array<{ url?: string; b64_json?: string }>;
    };
    const first = body.data?.[0] ?? body.images?.[0];
    const sourceUrl = body.url ?? first?.url;
    const b64 = first && "b64_json" in first ? first.b64_json : undefined;
    const providerId = body.id ?? (body.data?.[0] && "id" in body.data[0] ? body.data[0].id : undefined);
    let storedBytes: Uint8Array;
    let mediaType: string;
    let auditUrl: string;
    if (b64) {
      storedBytes = Uint8Array.from(Buffer.from(b64, "base64"));
      mediaType = "image/png";
      auditUrl = "data:image/png;base64";
      if (!hasImageSignature(mediaType, storedBytes)) {
        // some providers return jpeg in b64
        if (hasImageSignature("image/jpeg", storedBytes)) mediaType = "image/jpeg";
        else if (hasImageSignature("image/webp", storedBytes)) mediaType = "image/webp";
        else throw new HttpError(503, "图像服务返回了无法识别的图片数据");
      }
    } else if (sourceUrl) {
      const remote = await this.download(sourceUrl, signal);
      storedBytes = remote.bytes;
      mediaType = remote.mediaType;
      auditUrl = sourceUrl;
    } else {
      throw new HttpError(503, "图像服务没有返回图片");
    }
    if (storedBytes.byteLength === 0 || storedBytes.byteLength > MAX_IMAGE_BYTES) {
      throw new HttpError(503, storedBytes.byteLength === 0 ? "效果图内容为空" : "效果图超过 20MB，无法归档");
    }
    const safeProviderId = providerId?.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "generated";
    const stored = await this.files.put(
      input.projectId,
      `effect-${safeProviderId}${imageExtensions.get(mediaType) ?? ".png"}`,
      mediaType,
      storedBytes,
    );
    return { url: stored.url, fileId: stored.id, sourceUrl: auditUrl, providerId };
  }

  private async requestTextOnly(prompt: string, signal?: AbortSignal) {
    const body: Record<string, unknown> = { prompt, n: 1 };
    if (this.config.imageModel) body.model = this.config.imageModel;
    return this.fetcher(this.config.imageEndpoint!, {
      method: "POST",
      headers: { authorization: `Bearer ${this.config.imageApiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  }

  /** 有参考图：multipart /images/edits；model 用 imageEditModel。 */
  private async requestWithReferences(prompt: string, refs: ReferenceFile[], signal?: AbortSignal) {
    const endpoint = this.editsEndpoint();
    const form = new FormData();
    form.append("prompt", prompt);
    form.append("n", "1");
    if (this.config.imageEditModel) form.append("model", this.config.imageEditModel);
    for (const [index, ref] of refs.entries()) {
      const name = ref.filename ?? `ref-${index}${imageExtensions.get(ref.mediaType) ?? ".png"}`;
      form.append("image", new Blob([Buffer.from(ref.bytes)], { type: ref.mediaType }), name);
    }
    return this.fetcher(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${this.config.imageApiKey}` },
      body: form,
      signal,
    });
  }

  private editsEndpoint() {
    const base = this.config.imageEndpoint!;
    if (base.includes("/images/edits")) return base;
    if (base.includes("/images/generations")) return base.replace("/images/generations", "/images/edits");
    return base.endsWith("/") ? `${base}images/edits` : `${base}/images/edits`;
  }

  private async download(sourceUrl: string, signal?: AbortSignal) {
    let parsed: URL;
    try {
      parsed = new URL(sourceUrl);
    } catch {
      throw new HttpError(503, "图像服务返回了无效的图片 URL");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new HttpError(503, "图像服务返回了不支持的图片 URL");
    }
    const response = await this.fetcher(parsed, { signal });
    if (!response.ok) throw new HttpError(503, `效果图归档下载失败：${response.status}`);
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
    if (!imageExtensions.has(mediaType)) throw new HttpError(503, "效果图归档仅支持 JPG、PNG 和 WebP");
    const declaredSize = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_IMAGE_BYTES) {
      throw new HttpError(503, "效果图超过 20MB，无法归档");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new HttpError(503, bytes.byteLength === 0 ? "效果图内容为空" : "效果图超过 20MB，无法归档");
    }
    if (!hasImageSignature(mediaType, bytes)) throw new HttpError(503, "效果图内容与声明的图片类型不匹配");
    return { bytes, mediaType };
  }
}
