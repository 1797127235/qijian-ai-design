import { describe, expect, it, vi } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { createLookAtTool } from "./look-at.js";
import type { ToolContext } from "./shared.js";

function png(color: string) {
  const c = createCanvas(20, 20);
  const x = c.getContext("2d");
  x.fillStyle = color;
  x.fillRect(0, 0, 20, 20);
  return c.toBuffer("image/png");
}

function makeCtx(opts: {
  objects?: Array<{ id: string; x: number; y: number; fileId?: string; pending?: boolean; failed?: boolean }>;
}) {
  const objects = opts.objects ?? [
    { id: "art-1", x: 0, y: 0, fileId: "file-1" },
    { id: "art-2", x: 300, y: 0, fileId: "file-2" },
  ];
  const artifacts = objects.map((o) => ({
    id: o.id,
    artifactType: "canvas_image" as const,
    versionId: `v-${o.id}`,
    versionNo: 1,
    status: "draft" as const,
    payload: o.pending
      ? { pending: true }
      : o.failed
        ? { failed: true, error: "boom" }
        : o.fileId
          ? { file_id: o.fileId }
          : {},
    inputRefs: [],
    createdBy: "designer" as const,
    createdAt: new Date(),
  }));
  const files = {
    getById: vi.fn(async (id: string) => {
      if (!id.startsWith("file-")) return null;
      return {
        id,
        projectId: "proj-1",
        objectKey: `proj-1/${id}.png`,
        mediaType: "image/png",
      };
    }),
    read: vi.fn(async () => png("#336699")),
    originalFilenames: vi.fn(async () => ({ "file-1": "a.png", "file-2": "b.png" })),
  };
  const ctx: ToolContext & { files: typeof files } = {
    projectId: "proj-1",
    deps: {
      artifacts: {} as never,
      desks: {
        snapshot: vi.fn(async () => ({
          project: { id: "proj-1", name: "t" },
          artifacts,
          deskState: {
            objects: objects.map((o) => ({
              artifact_id: o.id,
              kind: "canvas_image",
              x: o.x,
              y: o.y,
              rot: 0,
            })),
            connections: [],
            viewport: { x: 0, y: 0, zoom: 1 },
            updatedAt: new Date(),
          },
        })),
        placeObject: vi.fn(),
      } as never,
      effects: {} as never,
      generate: {} as never,
      emit: vi.fn(),
    },
    selectedArtifactIds: () => [],
    changed: vi.fn(),
    ownedCurrent: vi.fn(),
    place: vi.fn(),
    files,
  };
  return ctx;
}

describe("look_at", () => {
  it("returns inspect image for ready artifact id", async () => {
    const ctx = makeCtx({});
    const tool = createLookAtTool(ctx);
    const result = await tool.execute("t1", { ids: ["art-1"] }, undefined, undefined, {} as never);
    expect(result.content.some((p) => p.type === "image")).toBe(true);
    expect(result.content.some((p) => p.type === "text" && "text" in p && p.text.includes("[INSPECT]"))).toBe(true);
    expect(result.details).toMatchObject({
      ok: true,
      role: "inspect",
      included_ids: ["art-1"],
      image_count: 1,
    });
    expect(ctx.files.read).toHaveBeenCalled();
  });

  it("resolves alias A01", async () => {
    const ctx = makeCtx({});
    const tool = createLookAtTool(ctx);
    const result = await tool.execute("t2", { ids: ["A01"] }, undefined, undefined, {} as never);
    expect(result.details).toMatchObject({ ok: true, role: "inspect", included_ids: ["art-1"] });
  });

  it("resolves mixed id and alias, dedupes", async () => {
    const ctx = makeCtx({});
    const tool = createLookAtTool(ctx);
    const result = await tool.execute(
      "t3",
      { ids: ["A01", "art-1", "art-2"] },
      undefined,
      undefined,
      {} as never,
    );
    expect(result.details).toMatchObject({
      ok: true,
      included_ids: ["art-1", "art-2"],
      image_count: 2,
    });
  });

  it("ok with skipped pending when at least one ready", async () => {
    const ctx = makeCtx({
      objects: [
        { id: "art-1", x: 0, y: 0, fileId: "file-1" },
        { id: "art-p", x: 100, y: 0, pending: true },
      ],
    });
    const tool = createLookAtTool(ctx);
    const result = await tool.execute(
      "t4",
      { ids: ["art-1", "art-p"] },
      undefined,
      undefined,
      {} as never,
    );
    expect(result.details).toMatchObject({ ok: true, image_count: 1 });
    expect(result.details).toMatchObject({
      skipped: expect.arrayContaining([expect.objectContaining({ id: "art-p", reason: "pending" })]),
    });
  });

  it("fails when no ready pixels", async () => {
    const ctx = makeCtx({
      objects: [{ id: "art-p", x: 0, y: 0, pending: true }],
    });
    const tool = createLookAtTool(ctx);
    const result = await tool.execute("t5", { ids: ["art-p"] }, undefined, undefined, {} as never);
    expect(result.content.every((p) => p.type === "text")).toBe(true);
    expect(result.details).toMatchObject({ ok: false, reason: "no_inspect_pixels" });
  });

  it("skips missing ids", async () => {
    const ctx = makeCtx({});
    const tool = createLookAtTool(ctx);
    const result = await tool.execute(
      "t6",
      { ids: ["art-1", "no-such"] },
      undefined,
      undefined,
      {} as never,
    );
    expect(result.details).toMatchObject({ ok: true, included_ids: ["art-1"] });
    expect(result.details).toMatchObject({
      skipped: expect.arrayContaining([expect.objectContaining({ id: "no-such", reason: "missing" })]),
    });
  });
});
