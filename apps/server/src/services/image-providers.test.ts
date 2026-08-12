import { describe, expect, it } from "vitest";
import {
  editsEndpointFrom,
  findDuplicateModelIds,
  listModelChoices,
  loadImageProviders,
  matchImageModelId,
  normalizeGenerationsUrl,
  resolveImageRoute,
  warnDuplicateImageModels,
} from "./image-providers.js";

describe("image providers", () => {
  it("normalizes base /v1 to generations", () => {
    expect(normalizeGenerationsUrl("http://openai2api.com:3000/v1")).toBe(
      "http://openai2api.com:3000/v1/images/generations",
    );
  });

  it("derives edits from generations", () => {
    expect(editsEndpointFrom("http://x/v1/images/generations")).toBe("http://x/v1/images/edits");
  });

  it("loads primary + provider 2", () => {
    const providers = loadImageProviders({
      IMAGE_API_URL: "https://a.example/v1/images/generations",
      IMAGE_API_KEY: "k1",
      IMAGE_MODEL: "grok-imagine-image-quality",
      IMAGE_MODEL_OPTIONS: "grok-imagine-image-quality,grok-imagine-image-pro",
      IMAGE_PROVIDER_2_URL: "http://openai2api.com:3000/v1",
      IMAGE_PROVIDER_2_KEY: "k2",
      IMAGE_PROVIDER_2_MODELS: "gpt-image-2",
      IMAGE_PROVIDER_2_ID: "openai2api",
      IMAGE_PROVIDER_2_LABEL: "OpenAI2API",
    });
    expect(providers).toHaveLength(2);
    expect(providers[1].endpoint).toContain("/images/generations");
    expect(providers[1].models).toEqual(["gpt-image-2"]);
    const choices = listModelChoices(providers);
    expect(choices.map((c) => c.id)).toEqual([
      "grok-imagine-image-quality",
      "grok-imagine-image-pro",
      "gpt-image-2",
    ]);
  });

  it("routes model to the owning provider", () => {
    const providers = loadImageProviders({
      IMAGE_API_URL: "https://a.example/v1/images/generations",
      IMAGE_API_KEY: "k1",
      IMAGE_MODEL: "grok-a",
      IMAGE_MODEL_OPTIONS: "grok-a",
      IMAGE_PROVIDER_2_URL: "http://b.example/v1/images/generations",
      IMAGE_PROVIDER_2_KEY: "k2",
      IMAGE_PROVIDER_2_MODELS: "gpt-image-2",
      IMAGE_PROVIDER_2_ID: "o2a",
    });
    const route = resolveImageRoute(providers, "gpt-image-2", false);
    expect(route).toMatchObject({ ok: true, model: "gpt-image-2" });
    if (!route.ok) throw new Error("expected ok");
    expect(route.provider.id).toBe("o2a");
    expect(route.provider.apiKey).toBe("k2");
  });

  it("rejects unknown model instead of silent primary fallback", () => {
    const providers = loadImageProviders({
      IMAGE_API_URL: "https://a.example/v1/images/generations",
      IMAGE_API_KEY: "k1",
      IMAGE_MODEL: "grok-a",
      IMAGE_MODEL_OPTIONS: "grok-a",
    });
    const route = resolveImageRoute(providers, "nope", false);
    expect(route).toEqual({ ok: false, reason: "unknown_model", model: "nope" });
  });

  it("normalizes spaced model names to allowlist id (E2)", () => {
    const providers = loadImageProviders({
      IMAGE_API_URL: "https://a.example/v1/images/generations",
      IMAGE_API_KEY: "k1",
      IMAGE_MODEL: "grok-a",
      IMAGE_MODEL_OPTIONS: "grok-a",
      IMAGE_PROVIDER_2_URL: "https://b.example/v1",
      IMAGE_PROVIDER_2_KEY: "k2",
      IMAGE_PROVIDER_2_MODELS: "gpt-image-2",
      IMAGE_PROVIDER_2_ID: "o2a",
    });
    const route = resolveImageRoute(providers, "gpt image2", false);
    expect(route).toMatchObject({ ok: true, model: "gpt-image-2" });
    expect(matchImageModelId("gpt image2", ["gpt-image-2"])).toBe("gpt-image-2");
    expect(matchImageModelId("nope", ["gpt-image-2"])).toBeNull();
    expect(matchImageModelId(undefined, ["gpt-image-2"])).toBeUndefined();
  });

  it("uses primary editModel when forEdit and no model requested", () => {
    const providers = loadImageProviders({
      IMAGE_API_URL: "https://a.example/v1/images/generations",
      IMAGE_API_KEY: "k1",
      IMAGE_MODEL: "grok-a",
      IMAGE_EDIT_MODEL: "grok-edit",
      IMAGE_MODEL_OPTIONS: "grok-a",
    });
    const route = resolveImageRoute(providers, undefined, true);
    expect(route).toMatchObject({ ok: true, model: "grok-edit" });
  });

  it("keeps selected model id for edits (same as generations)", () => {
    const providers = loadImageProviders({
      IMAGE_API_URL: "https://a.example/v1/images/generations",
      IMAGE_API_KEY: "k1",
      IMAGE_MODEL: "grok-a",
      IMAGE_EDIT_MODEL: "grok-edit",
      IMAGE_MODEL_OPTIONS: "grok-a,grok-b",
    });
    const route = resolveImageRoute(providers, "grok-b", true);
    expect(route).toMatchObject({ ok: true, model: "grok-b" });
  });

  it("finds duplicate model ids across providers", () => {
    const providers = loadImageProviders({
      IMAGE_API_URL: "https://a.example/v1/images/generations",
      IMAGE_API_KEY: "k1",
      IMAGE_MODEL: "shared",
      IMAGE_MODEL_OPTIONS: "shared",
      IMAGE_PROVIDER_2_URL: "http://b.example/v1",
      IMAGE_PROVIDER_2_KEY: "k2",
      IMAGE_PROVIDER_2_MODELS: "shared,other",
      IMAGE_PROVIDER_2_ID: "p2",
    });
    expect(findDuplicateModelIds(providers)).toEqual([
      { model: "shared", providerIds: ["primary", "p2"] },
    ]);
    const logs: string[] = [];
    warnDuplicateImageModels(providers, (m) => logs.push(m));
    expect(logs[0]).toContain("shared");
    expect(logs[0]).toContain("primary");
  });
});
