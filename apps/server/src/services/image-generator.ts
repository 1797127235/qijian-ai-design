import type { ServerConfig } from "../config.js";
import { HttpError } from "../lib/errors.js";

export interface GenerateImageInput {
  spaceId: string;
  intent?: string;
  context: string;
}

export interface GeneratedImage {
  url: string;
  providerId?: string;
}

export interface ImageGenerator {
  generate(input: GenerateImageInput): Promise<GeneratedImage>;
}

export class HttpImageGenerator implements ImageGenerator {
  constructor(private readonly config: ServerConfig) {}

  async generate(input: GenerateImageInput): Promise<GeneratedImage> {
    if (!this.config.imageEndpoint || !this.config.imageApiKey) {
      throw new HttpError(503, "尚未配置 IMAGE_API_URL 和 IMAGE_API_KEY，无法生成效果图");
    }
    const response = await fetch(this.config.imageEndpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${this.config.imageApiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: `${input.context}\n空间：${input.spaceId}\n补充意图：${input.intent ?? "无"}` }),
    });
    if (!response.ok) throw new HttpError(503, `图像服务调用失败：${response.status}`);
    const body = (await response.json()) as { data?: Array<{ url?: string; id?: string }>; url?: string; id?: string };
    const url = body.url ?? body.data?.[0]?.url;
    if (!url) throw new HttpError(503, "图像服务没有返回图片 URL");
    return { url, providerId: body.id ?? body.data?.[0]?.id };
  }
}
