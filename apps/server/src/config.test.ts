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

  it("defaults task queue settings to BullMQ runtime", () => {
    const config = loadConfig({});
    expect(config.redisUrl).toBe("redis://localhost:6379");
    expect(config.taskQueuePrefix).toBe("qijian");
    expect(config.taskWorkerConcurrency).toBe(4);
    expect(config.taskProjectImageConcurrency).toBe(4);
    expect(config.taskImageMaxAttempts).toBe(3);
    expect(config.taskImageBackoffMs).toBe(2_000);
    expect(config.taskOutboxMaxAttempts).toBe(20);
    expect(config.taskOutboxBackoffMs).toBe(1_000);
  });

  it("loads BullMQ settings and clamps worker concurrency", () => {
    const config = loadConfig({
      REDIS_URL: "redis://redis:6379/1",
      TASK_QUEUE_PREFIX: "test-suite",
      TASK_WORKER_CONCURRENCY: "100",
    });
    expect(config.redisUrl).toBe("redis://redis:6379/1");
    expect(config.taskQueuePrefix).toBe("test-suite");
    expect(config.taskWorkerConcurrency).toBe(32);
  });

  it("falls back to safe queue settings for invalid values", () => {
    const config = loadConfig({
      TASK_QUEUE_PREFIX: "  ",
      TASK_WORKER_CONCURRENCY: "zero",
    });
    expect(config.taskQueuePrefix).toBe("qijian");
    expect(config.taskWorkerConcurrency).toBe(4);
  });

  it("loads safe Bull Board defaults and normalizes its path", () => {
    const defaults = loadConfig({});
    expect(defaults.bullBoardPath).toBe("/admin/queues");
    expect(defaults.bullBoardReadOnly).toBe(true);
    expect(defaults.bullBoardUsername).toBeUndefined();
    expect(defaults.bullBoardPassword).toBeUndefined();

    const configured = loadConfig({
      BULL_BOARD_PATH: "ops/tasks/",
      BULL_BOARD_USERNAME: "operator",
      BULL_BOARD_PASSWORD: "secret",
      BULL_BOARD_READ_ONLY: "false",
    });
    expect(configured.bullBoardPath).toBe("/ops/tasks");
    expect(configured.bullBoardUsername).toBe("operator");
    expect(configured.bullBoardPassword).toBe("secret");
    expect(configured.bullBoardReadOnly).toBe(false);
  });
});
