import { describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../config.js";
import type { FileStorage } from "./file-storage.js";
import { HttpImageGenerator } from "./image-generator.js";

const config = {
  imageEndpoint: "https://provider.example/images/generations",
  imageApiKey: "test-key",
  imageModel: "grok-imagine-image-quality",
  imageEditModel: "grok-imagine-image-quality",
} as ServerConfig;

describe("HttpImageGenerator", () => {
  it("archives the generated image and returns the project file URL", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ url: "https://cdn.example/result.png", id: "provider-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), {
        status: 200,
        headers: { "content-type": "image/png", "content-length": "8" },
      }));
    const put = vi.fn().mockResolvedValue({ id: "file-1", url: "http://localhost:8787/api/files/file-1" });
    const generator = new HttpImageGenerator(config, { put } as unknown as FileStorage, fetcher);

    const result = await generator.generate({ projectId: "project-1", context: "context" });

    expect(fetcher).toHaveBeenCalledWith(
      "https://provider.example/images/generations",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ prompt: "context\n补充意图：无", n: 1, response_format: "b64_json", model: "grok-imagine-image-quality" }),
      }),
    );
    expect(put).toHaveBeenCalledWith("project-1", "effect-provider-1.png", "image/png", new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(result).toEqual({
      url: "http://localhost:8787/api/files/file-1",
      fileId: "file-1",
      sourceUrl: "https://cdn.example/result.png",
      providerId: "provider-1",
    });
  });

  it("rejects a provider response that is not an allowed image type", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ url: "https://cdn.example/result.html" }), { status: 200 }))
      .mockResolvedValueOnce(new Response("<html></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }));
    const put = vi.fn();
    const generator = new HttpImageGenerator(config, { put } as unknown as FileStorage, fetcher);

    await expect(generator.generate({ projectId: "project-1", context: "context" }))
      .rejects.toThrow("仅支持 JPG、PNG 和 WebP");
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects content whose bytes do not match the declared image type", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ url: "https://cdn.example/fake.png" }), { status: 200 }))
      .mockResolvedValueOnce(new Response("<html></html>", {
        status: 200,
        headers: { "content-type": "image/png" },
      }));
    const put = vi.fn();
    const generator = new HttpImageGenerator(config, { put } as unknown as FileStorage, fetcher);

    await expect(generator.generate({ projectId: "project-1", context: "context" }))
      .rejects.toThrow("内容与声明的图片类型不匹配");
    expect(put).not.toHaveBeenCalled();
  });
});
