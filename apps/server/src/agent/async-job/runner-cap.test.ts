import { describe, expect, it, vi } from "vitest";
import { AgentJobRunner, DeskGenerateCapError } from "./runner.js";
import type { AgentJobDto } from "./types.js";

function jobDto(id: string, patch: Partial<AgentJobDto> = {}): AgentJobDto {
  return {
    id,
    projectId: "p1",
    kind: "generate_from_desk",
    status: "accepted",
    input: {},
    createdAt: new Date().toISOString(),
    ...patch,
  };
}

describe("AgentJobRunner maxActive", () => {
  it("serializes create and rejects when count already at max", async () => {
    let active = 2;
    const create = vi.fn().mockImplementation(async () => {
      active += 1;
      return jobDto(`j-${active}`);
    });
    const countActiveByKind = vi.fn().mockImplementation(async () => active);
    const store = {
      create,
      countActiveByKind,
      setArtifact: vi.fn(),
      finalize: vi.fn(),
      listActiveByArtifact: vi.fn().mockResolvedValue([]),
    };
    const runner = new AgentJobRunner(store as never, () => undefined);

    await expect(
      runner.run({
        projectId: "p1",
        kind: "generate_from_desk",
        input: {},
        maxActive: { kind: "generate_from_desk", max: 2 },
        prepare: async () => ({}),
        work: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(DeskGenerateCapError);

    expect(create).not.toHaveBeenCalled();
  });

  it("allows create when under max and passes prepare", async () => {
    const created = jobDto("j-new");
    const store = {
      create: vi.fn().mockResolvedValue(created),
      countActiveByKind: vi.fn().mockResolvedValue(0),
      setArtifact: vi.fn(),
      finalize: vi.fn().mockResolvedValue(created),
      listActiveByArtifact: vi.fn().mockResolvedValue([]),
    };
    const runner = new AgentJobRunner(store as never, () => undefined);
    const prepare = vi.fn().mockResolvedValue({ artifactId: "fx-1" });

    const result = await runner.run({
      projectId: "p1",
      kind: "generate_from_desk",
      input: {},
      maxActive: { kind: "generate_from_desk", max: 2 },
      prepare,
      work: async () => ({ artifactId: "fx-1" }),
    });

    expect(result.details.status).toBe("accepted");
    expect(store.create).toHaveBeenCalled();
    expect(prepare).toHaveBeenCalled();
  });

  it("two concurrent runs under max=1: only one creates", async () => {
    let active = 0;
    const create = vi.fn().mockImplementation(async () => {
      active += 1;
      return jobDto(`j-${active}`);
    });
    const countActiveByKind = vi.fn().mockImplementation(async () => active);
    const store = {
      create,
      countActiveByKind,
      setArtifact: vi.fn(),
      finalize: vi.fn().mockImplementation(async (id: string) => jobDto(id, { status: "succeeded" })),
      listActiveByArtifact: vi.fn().mockResolvedValue([]),
    };
    const runner = new AgentJobRunner(store as never, () => undefined);

    const opts = {
      projectId: "p1",
      kind: "generate_from_desk" as const,
      input: {},
      maxActive: { kind: "generate_from_desk", max: 1 },
      prepare: async () => ({ artifactId: "fx" }),
      work: async () => undefined,
    };

    const results = await Promise.allSettled([
      runner.run(opts),
      runner.run(opts),
    ]);

    const ok = results.filter((r) => r.status === "fulfilled");
    const bad = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0].status === "rejected" && bad[0].reason).toBeInstanceOf(DeskGenerateCapError);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
