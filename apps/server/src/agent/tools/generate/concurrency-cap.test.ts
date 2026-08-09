import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentDeskGenerateMaxActive,
  DEFAULT_AGENT_DESK_GENERATE_MAX_ACTIVE,
  DESK_GENERATE_JOB_KIND,
} from "./shared/run-desk-generate.js";
import { createGenerateFromDeskTool } from "./from-source.js";
import { DeskGenerateCapError } from "../../async-job/runner.js";
import type { ToolContext } from "../shared.js";

function textOf(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content.map((part) => ("text" in part ? part.text : "")).join("");
}

describe("agentDeskGenerateMaxActive", () => {
  afterEach(() => {
    delete process.env.AGENT_DESK_GENERATE_MAX_ACTIVE;
  });

  it("defaults to 2", () => {
    expect(agentDeskGenerateMaxActive()).toBe(DEFAULT_AGENT_DESK_GENERATE_MAX_ACTIVE);
  });

  it("reads env clamp", () => {
    process.env.AGENT_DESK_GENERATE_MAX_ACTIVE = "5";
    expect(agentDeskGenerateMaxActive()).toBe(5);
  });
});

describe("generate_from_desk concurrency cap", () => {
  afterEach(() => {
    delete process.env.AGENT_DESK_GENERATE_MAX_ACTIVE;
  });

  it("maps DeskGenerateCapError from jobs.run to tool fail", async () => {
    process.env.AGENT_DESK_GENERATE_MAX_ACTIVE = "2";
    const run = vi.fn().mockRejectedValue(new DeskGenerateCapError(2, 2));
    const ctx = {
      projectId: "p1",
      selectedArtifactIds: () => ["img-1"],
      ownedCurrent: vi.fn().mockResolvedValue({ artifact: { projectId: "p1" } }),
      changed: vi.fn(),
      place: vi.fn(),
      session: { threadId: "t1", runId: () => "run-1" },
      deps: {
        generate: { prepare: vi.fn(), complete: vi.fn() },
        jobs: { run },
      },
    } as unknown as ToolContext;

    const tool = createGenerateFromDeskTool(ctx);
    const result = await tool.execute(
      "call-cap",
      { prompt: "客厅" },
      undefined,
      undefined,
      {} as never,
    );
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      maxActive: { kind: DESK_GENERATE_JOB_KIND, max: 2 },
    }));
    expect(textOf(result)).toContain("上限");
    expect(result.details).toMatchObject({
      reason: "desk_generate_concurrency_cap",
      active: 2,
      max: 2,
      ok: false,
    });
  });
});
