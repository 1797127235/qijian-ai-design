import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeskSnapshot } from "../domain/types.js";
import { revisionOf } from "../agent/desk-context.js";
import {
  COVER_FILENAME,
  ProjectCoverService,
  type CoverRenderResult,
} from "./project-cover-service.js";

function snapshot(partial?: Partial<DeskSnapshot>): DeskSnapshot {
  return {
    project: { id: "p1", name: "静安两居" },
    artifacts: [
      {
        id: "art-living",
        artifactType: "canvas_image",
        versionId: "v1",
        versionNo: 1,
        status: "draft",
        payload: { file_id: "file-living" },
        inputRefs: [],
        createdBy: "designer",
        createdAt: new Date("2026-08-06T00:00:00.000Z"),
      },
      {
        id: "art-fx",
        artifactType: "effect_image",
        versionId: "v2",
        versionNo: 1,
        status: "draft",
        payload: { file_id: "file-fx", user_prompt: "换暖光" },
        inputRefs: [],
        createdBy: "agent",
        createdAt: new Date("2026-08-06T00:00:00.000Z"),
      },
    ],
    deskState: {
      objects: [
        { artifact_id: "art-living", x: 0, y: 0, rot: 0, kind: "canvas_image" },
        { artifact_id: "art-fx", x: 400, y: 0, rot: 0, kind: "effect_image" },
      ],
      connections: [{ id: "c1", from: "art-living", to: "art-fx" }],
      viewport: { x: 40, y: 20, zoom: 0.62 },
      updatedAt: new Date("2026-08-07T00:00:00.000Z"),
    },
    ...partial,
  };
}

function pendingOnlySnapshot(): DeskSnapshot {
  const base = snapshot();
  return {
    ...base,
    artifacts: [{ ...base.artifacts[0], payload: { pending: true, prompt: "客厅" } }],
    deskState: { ...base.deskState, objects: [base.deskState.objects[0]], connections: [] },
  };
}

type FakeDeps = {
  calls: {
    render: number;
    put: { filename: string; mediaType: string }[];
    setCover: { fileId: string; revision: string }[];
    deleteFile: string[];
    errors: string[];
  };
  service: ProjectCoverService;
};

function makeService(overrides?: {
  snap?: DeskSnapshot;
  cover?: { fileId: string | null; revision: string | null };
  renderError?: boolean;
  debounceMs?: number;
}): FakeDeps {
  const snap = overrides?.snap ?? snapshot();
  const calls: FakeDeps["calls"] = { render: 0, put: [], setCover: [], deleteFile: [], errors: [] };
  const service = new ProjectCoverService({
    snapshot: async () => snap,
    getCover: async () => overrides?.cover ?? { fileId: null, revision: null },
    setCover: async (_projectId, fileId, revision) => {
      calls.setCover.push({ fileId, revision });
    },
    originalFilenames: async () => ({}),
    readImageBytes: async () => new Uint8Array([1, 2, 3]),
    putFile: async (_projectId, filename, mediaType) => {
      calls.put.push({ filename, mediaType });
      return { id: "cover-file-new" };
    },
    deleteFile: async (_projectId, fileId) => {
      calls.deleteFile.push(fileId);
    },
    render: async () => {
      calls.render += 1;
      if (overrides?.renderError) throw new Error("boom");
      return { png: Buffer.from("png-bytes"), mimeType: "image/png" as const };
    },
    debounceMs: overrides?.debounceMs ?? 8_000,
    onError: (error) => {
      calls.errors.push(error instanceof Error ? error.message : String(error));
    },
  });
  return { calls, service };
}

describe("ProjectCoverService.schedule", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("debounces multiple schedules into one render", async () => {
    const { calls, service } = makeService();
    service.schedule("p1");
    service.schedule("p1");
    service.schedule("p1");
    await vi.advanceTimersByTimeAsync(8_000);
    expect(calls.render).toBe(1);
    expect(calls.put).toHaveLength(1);
  });

  it("debounces per project independently", async () => {
    const { calls, service } = makeService();
    service.schedule("p1");
    service.schedule("p2");
    await vi.advanceTimersByTimeAsync(8_000);
    expect(calls.render).toBe(2);
  });

  it("cancel prevents a pending render", async () => {
    const { calls, service } = makeService();
    service.schedule("p1");
    service.cancel("p1");
    await vi.advanceTimersByTimeAsync(8_000);
    expect(calls.render).toBe(0);
  });

  it("render errors are reported, not thrown", async () => {
    const { calls, service } = makeService({ renderError: true });
    service.schedule("p1");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.errors).toEqual(["boom"]);
    expect(calls.put).toHaveLength(0);
  });
});

describe("ProjectCoverService.renderNow", () => {
  it("renders human-style cover and stores it, sweeping the old cover file", async () => {
    const { calls, service } = makeService({
      cover: { fileId: "cover-file-old", revision: "stale-rev" },
    });
    const result: CoverRenderResult = await service.renderNow("p1");
    expect(result).toEqual({ rendered: true, fileId: "cover-file-new" });
    expect(calls.put).toEqual([{ filename: COVER_FILENAME, mediaType: "image/png" }]);
    expect(calls.setCover).toEqual([{ fileId: "cover-file-new", revision: revisionOf(snapshot()) }]);
    expect(calls.deleteFile).toEqual(["cover-file-old"]);
  });

  it("skips when stored revision matches the current snapshot", async () => {
    const rev = revisionOf(snapshot());
    const { calls, service } = makeService({ cover: { fileId: "cover-1", revision: rev } });
    const result = await service.renderNow("p1");
    expect(result).toEqual({ rendered: false, reason: "revision_unchanged" });
    expect(calls.render).toBe(0);
    expect(calls.put).toHaveLength(0);
  });

  it("keeps the old cover when the desk has no ready pixels", async () => {
    const { calls, service } = makeService({
      snap: pendingOnlySnapshot(),
      cover: { fileId: "cover-file-old", revision: "stale-rev" },
    });
    const result = await service.renderNow("p1");
    expect(result).toEqual({ rendered: false, reason: "no_ready_pixels" });
    expect(calls.put).toHaveLength(0);
    expect(calls.setCover).toHaveLength(0);
    expect(calls.deleteFile).toHaveLength(0);
  });
});
