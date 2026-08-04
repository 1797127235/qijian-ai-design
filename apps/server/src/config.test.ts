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
});
