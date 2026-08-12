import { describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../config.js";
import type { FileStorage } from "./file-storage.js";
import { HttpImageGenerator } from "./image-generator.js";

const config = {
  imageEndpoint: "https://provider.example/images/generations",
  imageApiKey: "test-key",
  imageModel: "grok-imagine-image-quality",
  imageEditModel: "grok-imagine-image-quality",
  imageModelOptions: ["grok-imagine-image-quality", "grok-imagine-image-pro"],
  imageModelChoices: [
    { id: "grok-imagine-image-quality", providerId: "primary", providerLabel: "Primary" },
    { id: "grok-imagine-image-pro", providerId: "primary", providerLabel: "Primary" },
  ],
  imageProviders: [
    {
      id: "primary",
      label: "Primary",
      endpoint: "https://provider.example/images/generations",
      apiKey: "test-key",
      models: ["grok-imagine-image-quality", "grok-imagine-image-pro"],
      editModel: "grok-imagine-image-quality",
    },
  ],
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

  it("includes resolved size on text-only request", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ b64_json: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64") }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const put = vi.fn().mockResolvedValue({ id: "file-s", url: "http://localhost:8787/api/files/file-s" });
    const generator = new HttpImageGenerator(config, { put } as unknown as FileStorage, fetcher);

    await generator.generate({ projectId: "project-1", context: "ctx", size: "1:1" });

    const body = JSON.parse(String(fetcher.mock.calls[0][1].body));
    expect(body.size).toBe("1024x1024");
  });

  it("uses per-request model when allowlisted", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ b64_json: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64") }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const put = vi.fn().mockResolvedValue({ id: "file-m", url: "http://localhost:8787/api/files/file-m" });
    const generator = new HttpImageGenerator(config, { put } as unknown as FileStorage, fetcher);

    await generator.generate({ projectId: "project-1", context: "ctx", model: "grok-imagine-image-pro" });

    const body = JSON.parse(String(fetcher.mock.calls[0][1].body));
    expect(body.model).toBe("grok-imagine-image-pro");
  });

  it("rejects unknown request model with 400", async () => {
    const fetcher = vi.fn();
    const put = vi.fn();
    const generator = new HttpImageGenerator(config, { put } as unknown as FileStorage, fetcher);

    await expect(
      generator.generate({ projectId: "project-1", context: "ctx", model: "not-a-real-model" }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("not-a-real-model") });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("routes model to a second provider endpoint and key", async () => {
    const multi = {
      ...config,
      imageProviders: [
        ...config.imageProviders!,
        {
          id: "openai2api",
          label: "OpenAI2API",
          endpoint: "http://openai2api.example/v1/images/generations",
          apiKey: "key-2",
          models: ["gpt-image-2"],
        },
      ],
      imageModelOptions: [...config.imageModelOptions!, "gpt-image-2"],
    } as ServerConfig;
    const fetcher = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ b64_json: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64") }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const put = vi.fn().mockResolvedValue({ id: "file-p2", url: "http://localhost:8787/api/files/file-p2" });
    const generator = new HttpImageGenerator(multi, { put } as unknown as FileStorage, fetcher);

    await generator.generate({ projectId: "project-1", context: "ctx", model: "gpt-image-2" });

    expect(fetcher).toHaveBeenCalledWith(
      "http://openai2api.example/v1/images/generations",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer key-2" }),
      }),
    );
    const body = JSON.parse(String(fetcher.mock.calls[0][1].body));
    expect(body.model).toBe("gpt-image-2");
  });

  it("falls back to direct download when proxy download fails", async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const apiFetcher = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ url: "https://cdn.example/result.png", id: "p2" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const proxyDownload = vi.fn().mockRejectedValue(new Error("proxy down"));
    const directDownload = vi.fn().mockResolvedValueOnce(
      new Response(png, { status: 200, headers: { "content-type": "image/png", "content-length": "8" } }),
    );
    // generate 用 apiFetcher；download 优先 proxyDownload，失败后直连 directDownload
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/images/generations")) return apiFetcher(url, init);
      return directDownload(url, init);
    }) as unknown as typeof fetch;
    const put = vi.fn().mockResolvedValue({ id: "file-2", url: "http://localhost:8787/api/files/file-2" });
    const generator = new HttpImageGenerator(
      config,
      { put } as unknown as FileStorage,
      fetcher,
      proxyDownload as unknown as typeof fetch,
    );

    const result = await generator.generate({ projectId: "project-1", context: "ctx" });

    expect(proxyDownload).toHaveBeenCalled();
    expect(directDownload).toHaveBeenCalled();
    expect(result.fileId).toBe("file-2");
    expect(put).toHaveBeenCalled();
  });
});
