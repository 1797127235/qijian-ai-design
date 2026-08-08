import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("server config", () => {
  it("selects the documented pi model by default", () => {
    const config = loadConfig({});
    expect(config.agentProvider).toBe("codex2api");
    expect(config.agentModel).toBe("grok-4.5-latest");
  });

  it("allows the pi model to be overridden", () => {
    const config = loadConfig({ AGENT_PROVIDER: "internal", AGENT_MODEL: "model-one" });
    expect(config.agentProvider).toBe("internal");
    expect(config.agentModel).toBe("model-one");
  });

  it("builds image model options including the default model", () => {
    const config = loadConfig({ IMAGE_MODEL: "grok-imagine-image-quality" });
    expect(config.imageModelOptions[0]).toBe("grok-imagine-image-quality");
    expect(config.imageModelOptions).toContain("grok-imagine-image-pro");
  });

  it("parses IMAGE_MODEL_OPTIONS and keeps default first", () => {
    const config = loadConfig({
      IMAGE_MODEL: "alpha",
      IMAGE_MODEL_OPTIONS: "beta, alpha, gamma",
    });
    expect(config.imageModelOptions).toEqual(["alpha", "beta", "gamma"]);
  });

  it("defaults langsmith tracing off", () => {
    const config = loadConfig({});
    expect(config.langsmithTracing).toBe(false);
    expect(config.langsmithProject).toBe("pi");
  });

  it("enables langsmith from env", () => {
    const config = loadConfig({
      LANGSMITH_TRACING: "true",
      LANGSMITH_API_KEY: "lsv2_test",
      LANGSMITH_PROJECT: "pi",
    });
    expect(config.langsmithTracing).toBe(true);
    expect(config.langsmithApiKey).toBe("lsv2_test");
  });
});
