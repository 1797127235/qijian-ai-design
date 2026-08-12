import { describe, expect, it, vi } from "vitest";
import { ImageCaptionStore } from "./image-caption-store.js";

function mockDb(handlers: {
  selectFile?: unknown[];
  selectCaptions?: unknown[];
  insert?: () => unknown;
}) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    then: undefined as unknown,
  };
  // make awaitable via thenable for select paths
  const selectResult = {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockImplementation(async () => handlers.selectFile ?? handlers.selectCaptions ?? []),
    }),
  };
  let selectCall = 0;
  const db = {
    select: vi.fn().mockImplementation(() => {
      selectCall += 1;
      // first select often fileHashes/getMany; tests set arrays in order via handlers
      if (handlers.selectCaptions && selectCall > 1) {
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(handlers.selectCaptions),
          }),
        };
      }
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(handlers.selectFile ?? handlers.selectCaptions ?? []),
        }),
      };
    }),
    insert: vi.fn().mockImplementation(() => {
      const insertChain = {
        values: vi.fn().mockReturnThis(),
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      };
      handlers.insert?.();
      return insertChain;
    }),
  };
  void chain;
  void selectResult;
  return db as never;
}

describe("ImageCaptionStore.getMany", () => {
  it("returns only exact triple matches", async () => {
    const db = mockDb({
      selectCaptions: [
        {
          fileId: "f1",
          text: "客厅",
          contentHash: "h1",
          analyzerVersion: "v1",
        },
        {
          fileId: "f1",
          text: "旧版",
          contentHash: "h0",
          analyzerVersion: "v1",
        },
      ],
    });
    const store = new ImageCaptionStore(db);
    const hits = await store.getMany("p1", [
      { fileId: "f1", contentHash: "h1", analyzerVersion: "v1" },
    ]);
    expect(hits.get("f1")?.text).toBe("客厅");
    expect(hits.size).toBe(1);
  });
});

describe("ImageCaptionStore.upsert", () => {
  it("rejects when stored file hash mismatches (CAS)", async () => {
    const db = mockDb({
      selectFile: [{ id: "f1", contentHash: "new-hash", projectId: "p1" }],
    });
    const store = new ImageCaptionStore(db);
    const ok = await store.upsert({
      projectId: "p1",
      fileId: "f1",
      contentHash: "old-hash",
      analyzerVersion: "v1",
      text: "应被拒绝",
    });
    expect(ok).toBe(false);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("writes when hash matches project file", async () => {
    const db = mockDb({
      selectFile: [{ id: "f1", contentHash: "h1", projectId: "p1" }],
    });
    const store = new ImageCaptionStore(db);
    const ok = await store.upsert({
      projectId: "p1",
      fileId: "f1",
      contentHash: "h1",
      analyzerVersion: "v1",
      text: "浅木地板",
    });
    expect(ok).toBe(true);
    expect(db.insert).toHaveBeenCalled();
  });
});
