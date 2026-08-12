import { ProxyAgent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";
import type { ServerConfig } from "../config.js";
import { HttpError } from "../lib/errors.js";
import type { FileStorage } from "./file-storage.js";
import { editsEndpointFrom, resolveImageRoute, type ImageProviderConfig } from "./image-providers.js";
import { resolveRequestSize } from "./image-size.js";

/**
 * 图像生成适配器：OpenAI 兼容文生图/图编辑；支持多网关（按 model 路由）。
 *
 *  - 两条请求路径：text-only（POST /images/generations）+ with-refs（POST /images/edits）
 *  - 优先 b64_json 响应：避免再访问被墙的结果图床
 *  - 结果图下载走专用 downloadFetcher：上游 x.ai 图床被墙时代理转发（国内 dev 必要）
 *  - 所有响应做签名校验（JPEG/PNG/WEBP magic），杜绝「返回了 HTML 错误页但 200」伪造
 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** 从错误响应里抠上游 message，避免「400」裸奔无法排查。 */
async function errorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.clone().json()) as { error?: { message?: unknown }; message?: unknown };
    const message = body.error?.message ?? body.message;
    if (typeof message === "string" && message.trim()) return `：${message.trim().slice(0, 200)}`;
  } catch {
    // 非 JSON 响应忽略
  }
  return "";
}
/** mediaType → 文件扩展名映射。 */
const imageExtensions = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
]);

/** 校验图片文件 magic bytes（不是看扩展名/Content-Type），防止被假响应骗。 */
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
  /** UI/env 偏好：比例或 "WxH"；解析失败或 auto 则不传上游 size */
  size?: string;
  /** 单次请求 model；须在 allowlist 内，否则回落 config */
  model?: string;
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
  private readonly config: ServerConfig;
  private readonly files: FileStorage;
  private readonly fetcher: typeof fetch;
  /** 仅结果图下载优先走代理：x.ai 图床被墙，而生成 API（codex2api）直连可达 */
  private readonly downloadFetcher: typeof fetch;
  /** downloadFetcher 与 fetcher 不同时，代理失败会直连重试 */
  private readonly canFallbackDirect: boolean;

  constructor(
    config: ServerConfig,
    files: FileStorage,
    fetcher?: typeof fetch,
    /** 测试可注入独立下载 fetcher；生产由 IMAGE_FETCH_PROXY 构造 */
    downloadFetcher?: typeof fetch,
  ) {
    this.config = config;
    this.files = files;
    this.fetcher = fetcher ?? fetch;
    const proxy = config.imageFetchProxy?.trim();
    if (downloadFetcher) {
      this.downloadFetcher = downloadFetcher;
    } else if (!fetcher && proxy) {
      // 注意：只对 GET 下载用 undici@8 fetch；其 multipart 序列化会让上游丢字段
      const dispatcher = new ProxyAgent(proxy);
      this.downloadFetcher = ((url: string | URL | Request, init?: RequestInit) =>
        undiciFetch(url as string, { ...(init as unknown as UndiciRequestInit), dispatcher })) as unknown as typeof fetch;
    } else {
      this.downloadFetcher = this.fetcher;
    }
    this.canFallbackDirect = this.downloadFetcher !== this.fetcher;
  }

  /** 包一层：undici 的「fetch failed」裸消息没营养，带上 cause（UND_ERR_CONNECT_TIMEOUT 等） */
  private async send(fetcher: typeof fetch, url: string | URL, init?: RequestInit): Promise<Response> {
    try {
      return await fetcher(url, init);
    } catch (error) {
      const cause = (error as { cause?: { code?: string; message?: string } } | null)?.cause;
      const detail = cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : undefined);
      throw new HttpError(503, `图像服务网络错误${detail ? `：${detail}` : ""}`);
    }
  }

  /**
   * 主入口：调用上游 → 拿到 b64 或 url → 入库到本项目 → 返回 fileId/url/sourceUrl。
   * 异常时一律抛 HttpError 503（网络/上游问题，retryable=true 让前端可重试）。
   */
  async generate(input: GenerateImageInput, signal?: AbortSignal): Promise<GeneratedImage> {
    const route = this.resolveRoute(input);
    if (!route.ok) {
      if (route.reason === "unknown_model") {
        throw new HttpError(400, `未知生图 model：${route.model}`);
      }
      throw new HttpError(503, "尚未配置 IMAGE_API_URL 和 IMAGE_API_KEY，无法生成效果图");
    }
    const { provider, model } = route;
    const prompt = `${input.context}\n补充意图：${input.intent ?? "无"}`;
    // xAI grok-imagine edit 只接受单张参考图，多图必 400；取第一张（源图），其余靠 prompt 描述
    const refs = (input.referenceFiles ?? []).slice(0, 1);
    const size = resolveRequestSize(input.size ?? this.config.imageSize);
    const call = (resolvedSize?: string) =>
      refs.length > 0
        ? this.requestWithReferences(provider, prompt, refs, signal, resolvedSize, model)
        : this.requestTextOnly(provider, prompt, signal, resolvedSize, model);
    let response = await call(size);
    // 上游若因 size 400，omit 后重试一次（契约：size 不得硬杀生图）
    if (!response.ok && size && response.status === 400) {
      response = await call(undefined);
    }
    if (!response.ok) throw new HttpError(503, `图像服务调用失败：${response.status}${await errorDetail(response)}`);
    let body: {
      data?: Array<{ url?: string; b64_json?: string; id?: string }>;
      url?: string;
      id?: string;
      images?: Array<{ url?: string; b64_json?: string }>;
    };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      throw new HttpError(503, "图像服务返回了无效响应");
    }
    const first = body.data?.[0] ?? body.images?.[0];
    const sourceUrl = body.url ?? first?.url;
    const b64 = first && "b64_json" in first ? first.b64_json : undefined;
    const providerId = body.id ?? (body.data?.[0] && "id" in body.data[0] ? body.data[0].id : undefined);
    let storedBytes: Uint8Array;
    let mediaType: string;
    let auditUrl: string;
    if (b64) {
      // base64 膨胀约 4/3；先按字符长度拒超大串，避免解码时内存放大
      if (b64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 8) {
        throw new HttpError(503, "效果图超过 20MB，无法归档");
      }
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

  /** 优先 imageProviders 路由；测试/旧配置仅有 imageEndpoint 时回落拼主站。 */
  private resolveRoute(input: GenerateImageInput) {
    const forEdit = (input.referenceFiles?.length ?? 0) > 0;
    const providers = this.config.imageProviders ?? [];
    if (providers.length > 0) {
      return resolveImageRoute(providers, input.model, forEdit);
    }
    if (!this.config.imageEndpoint || !this.config.imageApiKey) {
      return { ok: false as const, reason: "no_providers" as const };
    }
    const models = this.config.imageModelOptions?.length
      ? this.config.imageModelOptions
      : [this.config.imageModel ?? "default"];
    const provider = {
      id: "primary",
      label: "Primary",
      endpoint: this.config.imageEndpoint,
      apiKey: this.config.imageApiKey,
      models,
      editModel: this.config.imageEditModel,
    } satisfies ImageProviderConfig;
    return resolveImageRoute([provider], input.model, forEdit);
  }

  /** 无参考图：直接 POST /images/generations，response_format=b64_json 省一次下载。 */
  private async requestTextOnly(
    provider: ImageProviderConfig,
    prompt: string,
    signal?: AbortSignal,
    size?: string,
    model?: string,
  ) {
    const body: Record<string, unknown> = { prompt, n: 1, response_format: "b64_json" };
    if (model) body.model = model;
    if (size) body.size = size;
    return this.send(this.fetcher, provider.endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${provider.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  }

  /** 有参考图：multipart /images/edits。xAI grok-imagine edit 只接受单张参考图（调用方已截断）。 */
  private async requestWithReferences(
    provider: ImageProviderConfig,
    prompt: string,
    refs: ReferenceFile[],
    signal?: AbortSignal,
    size?: string,
    model?: string,
  ) {
    const endpoint = editsEndpointFrom(provider.endpoint);
    const form = new FormData();
    form.append("prompt", prompt);
    form.append("n", "1");
    form.append("response_format", "b64_json");
    if (model) form.append("model", model);
    if (size) form.append("size", size);
    for (const [index, ref] of refs.entries()) {
      const name = ref.filename ?? `ref-${index}${imageExtensions.get(ref.mediaType) ?? ".png"}`;
      form.append("image", new Blob([Buffer.from(ref.bytes)], { type: ref.mediaType }), name);
    }
    return this.send(this.fetcher, endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${provider.apiKey}` },
      body: form,
      signal,
    });
  }

  /**
   * 下载上游图床结果：protocol/host 白名单 → content-type → 有界流式读 body → magic 校验。
   * 禁止默认 redirect，降低 SSRF；body 超限立即中止。
   * 配置了代理时：先代理，失败再直连（代理关/超时仍可能直连拿到图）。
   */
  private async download(sourceUrl: string, signal?: AbortSignal) {
    let parsed: URL;
    try {
      parsed = new URL(sourceUrl);
    } catch {
      throw new HttpError(503, "图像服务返回了无效的图片 URL");
    }
    assertSafeImageUrl(parsed);
    try {
      return await this.downloadOnce(this.downloadFetcher, parsed, signal);
    } catch (error) {
      if (!this.canFallbackDirect || signal?.aborted) throw error;
      return this.downloadOnce(this.fetcher, parsed, signal);
    }
  }

  private async downloadOnce(fetcher: typeof fetch, parsed: URL, signal?: AbortSignal) {
    const response = await this.send(fetcher, parsed, { signal, redirect: "error" });
    if (!response.ok) throw new HttpError(503, `效果图归档下载失败：${response.status}`);
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
    if (!imageExtensions.has(mediaType)) throw new HttpError(503, "效果图归档仅支持 JPG、PNG 和 WebP");
    const declaredSize = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_IMAGE_BYTES) {
      throw new HttpError(503, "效果图超过 20MB，无法归档");
    }
    const bytes = await readBodyBounded(response, MAX_IMAGE_BYTES, signal);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new HttpError(503, bytes.byteLength === 0 ? "效果图内容为空" : "效果图超过 20MB，无法归档");
    }
    if (!hasImageSignature(mediaType, bytes)) throw new HttpError(503, "效果图内容与声明的图片类型不匹配");
    return { bytes, mediaType };
  }
}

function assertSafeImageUrl(parsed: URL) {
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new HttpError(503, "图像服务返回了不支持的图片 URL");
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost"
    || host.endsWith(".localhost")
    || host === "0.0.0.0"
    || host === "::1"
    || host === "[::1]"
    || host.endsWith(".local")
    || host.endsWith(".internal")
    || isPrivateOrLinkLocalHost(host)
  ) {
    throw new HttpError(503, "图像服务返回了不允许的图片主机");
  }
}

function isPrivateOrLinkLocalHost(host: string) {
  // IPv4 dotted form only; hostnames are allowed (provider CDNs).
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return true;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

async function readBodyBounded(response: Response, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (!response.body) {
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new HttpError(503, "效果图超过 20MB，无法归档");
    return buf;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError(503, "效果图超过 20MB，无法归档");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
