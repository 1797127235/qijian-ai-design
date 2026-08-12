import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactNameTaskService } from "./artifact-name-task.js";
import type { ArtifactNameTaskV1 } from "./types.js";

vi.mock("../services/artifact-display-namer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/artifact-display-namer.js")>();
  return {
    ...actual,
    suggestArtifactDisplayName: vi.fn(),
  };
});

import { suggestArtifactDisplayName } from "../services/artifact-display-namer.js";

const suggest = vi.mocked(suggestArtifactDisplayName);

function nameTask(over: Partial<ArtifactNameTaskV1> = {}): ArtifactNameTaskV1 {
  return {
    schema_version: 1,
    kind: "artifact.name",
    project_id: "11111111-1111-4111-8111-111111111111",
    task_id: "22222222-2222-4222-8222-222222222222",
    artifact_id: "33333333-3333-4333-8333-333333333333",
    artifact_version_id: "44444444-4444-4444-8444-444444444444",
    name_version: 1,
    generation_token: "tok-1",
    display_name_source: "system",
    naming_input: "储藏室效果图",
    ...over,
  };
}

describe("ArtifactNameTaskService soft-fail", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("falls back to heuristic system name when provider never returns a name", async () => {
    vi.useFakeTimers();
    suggest.mockResolvedValue(undefined);
    const applyGeneratedDisplayName = vi.fn().mockResolvedValue(true);
    const service = new ArtifactNameTaskService(
      {} as never,
      { applyGeneratedDisplayName } as never,
      { textEndpoint: "http://x", textApiKey: "k", textModel: "m" },
    );

    const pending = service.handle(nameTask());
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toEqual({
      artifactId: "33333333-3333-4333-8333-333333333333",
      displayName: "储藏室效果图",
      applied: true,
      reason: "heuristic_applied",
    });
    expect(applyGeneratedDisplayName).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "储藏室效果图",
        writeSource: "system",
        displayNameSource: "system",
      }),
    );
    expect(suggest).toHaveBeenCalledTimes(3);
  });

  it("reports provider_no_valid_name when LLM and heuristic both empty", async () => {
    vi.useFakeTimers();
    suggest.mockResolvedValue(undefined);
    const applyGeneratedDisplayName = vi.fn();
    const service = new ArtifactNameTaskService(
      {} as never,
      { applyGeneratedDisplayName } as never,
      { textEndpoint: "http://x", textApiKey: "k", textModel: "m" },
    );

    const pending = service.handle(nameTask({ naming_input: "A07" }));
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toEqual({
      artifactId: "33333333-3333-4333-8333-333333333333",
      displayName: null,
      applied: false,
      reason: "provider_no_valid_name",
    });
    expect(applyGeneratedDisplayName).not.toHaveBeenCalled();
  });

  it("returns applied=false when generation token is blocked (user rename)", async () => {
    suggest.mockResolvedValue("客厅 · 暖木");
    const applyGeneratedDisplayName = vi.fn().mockResolvedValue(false);
    const service = new ArtifactNameTaskService(
      {} as never,
      { applyGeneratedDisplayName } as never,
      { textEndpoint: "http://x", textApiKey: "k", textModel: "m" },
    );

    const result = await service.handle(nameTask());

    expect(result.applied).toBe(false);
    expect(result.reason).toBe("token_or_user_blocked");
    expect(result.displayName).toBe("客厅 · 暖木");
    expect(applyGeneratedDisplayName).toHaveBeenCalledOnce();
  });

  it("returns applied=true with writeSource=model when LLM succeeds", async () => {
    suggest.mockResolvedValue("储藏室");
    const applyGeneratedDisplayName = vi.fn().mockResolvedValue(true);
    const service = new ArtifactNameTaskService(
      {} as never,
      { applyGeneratedDisplayName } as never,
      { textEndpoint: "http://x", textApiKey: "k", textModel: "m" },
    );

    const result = await service.handle(nameTask());

    expect(result).toMatchObject({
      displayName: "储藏室",
      applied: true,
      reason: "applied",
    });
    expect(applyGeneratedDisplayName).toHaveBeenCalledWith(
      expect.objectContaining({ writeSource: "model", name: "储藏室" }),
    );
  });

  it("skips LLM and uses heuristic when text API is not configured", async () => {
    const applyGeneratedDisplayName = vi.fn().mockResolvedValue(true);
    const service = new ArtifactNameTaskService(
      {} as never,
      { applyGeneratedDisplayName } as never,
      {},
    );

    const result = await service.handle(
      nameTask({ naming_input: "三室一厅彩色平面图彩平" }),
    );

    expect(suggest).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      applied: true,
      reason: "heuristic_applied",
      displayName: "三室一厅彩平",
    });
    expect(applyGeneratedDisplayName).toHaveBeenCalledWith(
      expect.objectContaining({ writeSource: "system" }),
    );
  });
});
