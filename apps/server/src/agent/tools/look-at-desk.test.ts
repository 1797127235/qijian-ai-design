import { describe, expect, it, vi } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { createLookAtDeskTool } from "./look-at-desk.js";
import type { ToolContext } from "./shared.js";

function png(color: string) {
  const c = createCanvas(20, 20);
  const x = c.getContext("2d");
  x.fillStyle = color;
  x.fillRect(0, 0, 20, 20);
  return c.toBuffer("image/png");
}

function makeCtx(opts: {
  objects?: Array<{ id: string; x: number; y: number; fileId?: string; pending?: boolean }>;
  selected?: string[];
}): ToolContext & { files: { getById: ReturnType<typeof vi.fn>; read: ReturnType<typeof vi.fn>; originalFilenames: ReturnType<typeof vi.fn> } } {
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
    payload: o.pending ? { pending: true } : o.fileId ? { file_id: o.fileId } : {},
    inputRefs: [],
    createdBy: "designer" as const,
    createdAt: new Date(),
  }));
  const files = {
    getById: vi.fn(async (id: string) => ({
      id,
      projectId: "proj-1",
      objectKey: `proj-1/${id}.png`,
      mediaType: "image/png",
    })),
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
            connections: objects.length >= 2
              ? [{ id: "c1", from: objects[0]!.id, to: objects[1]!.id }]
              : [],
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
    selectedArtifactIds: () => opts.selected ?? [],
    changed: vi.fn(),
    ownedCurrent: vi.fn(),
    place: vi.fn(),
    files,
  };
  return ctx;
}

describe("look_at_desk", () => {
  it("returns image when ready tiles exist", async () => {
    const ctx = makeCtx({ selected: ["art-1"] });
    const tool = createLookAtDeskTool(ctx);
    const result = await tool.execute("t1", {}, undefined, undefined, {} as never);
    expect(result.content.some((p) => p.type === "image")).toBe(true);
    expect(result.content.some((p) => p.type === "text" && "text" in p && p.text.includes("desk_overview"))).toBe(true);
    expect(result.details).toMatchObject({ ok: true, role: "desk_overview" });
    expect(ctx.files.read).toHaveBeenCalled();
  });

  it("fails whole tool when no ready pixels", async () => {
    const ctx = makeCtx({
      objects: [{ id: "art-p", x: 0, y: 0, pending: true }],
    });
    const tool = createLookAtDeskTool(ctx);
    const result = await tool.execute("t2", {}, undefined, undefined, {} as never);
    expect(result.content.every((p) => p.type === "text")).toBe(true);
    expect(result.details).toMatchObject({ ok: false, reason: "no_ready_pixels" });
  });
});
