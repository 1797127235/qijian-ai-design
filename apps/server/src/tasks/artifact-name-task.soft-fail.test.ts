import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactNameTaskService } from "./artifact-name-task.js";
import type { ArtifactNameTaskV1 } from "./types.js";

vi.mock("../services/artifact-display-namer.js", () => ({
  suggestArtifactDisplayName: vi.fn(),
}));

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
    display_name_source: "model",
    naming_input: "储藏室效果图",
    ...over,
  };
}

describe("ArtifactNameTaskService soft-fail", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("succeeds with applied=false when provider never returns a name (does not throw)", async () => {
    vi.useFakeTimers();
    suggest.mockResolvedValue(undefined);
    const applyGeneratedDisplayName = vi.fn();
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
      displayName: null,
      applied: false,
      reason: "provider_no_valid_name",
    });
    expect(applyGeneratedDisplayName).not.toHaveBeenCalled();
    expect(suggest).toHaveBeenCalledTimes(3);
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

  it("returns applied=true when write succeeds", async () => {
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
  });
});
