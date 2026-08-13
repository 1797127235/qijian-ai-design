import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../lib/errors.js";
import { FileStorage, inspectUpload } from "./file-storage.js";

describe("inspectUpload", () => {
  it("decodes a real PNG instead of trusting the declared MIME type", async () => {
    const bytes = await readFile("public/cad-sheet.png");
    await expect(inspectUpload(bytes, "image/png")).resolves.toEqual({});
  });

  it("rejects content whose bytes do not match the declared type", async () => {
    await expect(inspectUpload(new TextEncoder().encode("not an image"), "image/png")).rejects.toMatchObject({
      code: "INVALID_FILE_CONTENT",
    } satisfies Partial<AppError>);
  });
});

describe("FileStorage.gcUnattached", () => {
  it("deletes old unreferenced files and skips referenced or young ones", async () => {
    const now = new Date("2026-08-09T12:00:00.000Z");
    const oldOrphan = {
      id: "old-orphan",
      projectId: "p1",
      createdAt: new Date("2026-08-09T10:00:00.000Z"),
    };
    const youngOrphan = {
      id: "young-orphan",
      projectId: "p1",
      createdAt: new Date("2026-08-09T11:30:00.000Z"),
    };
    const oldReferenced = {
      id: "old-ref",
      projectId: "p1",
      createdAt: new Date("2026-08-09T09:00:00.000Z"),
    };

    const selectResult = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([oldOrphan, oldReferenced]),
    };
    const db = {
      select: vi.fn(() => selectResult),
      transaction: vi.fn(),
    };

    const storage = new FileStorage(db as never, {
      uploadDir: "/tmp/qijian-test-uploads",
      publicBaseUrl: "http://localhost",
    } as never);

    const referenced = new Set(["old-ref"]);
    storage.setReferenceCheckers([
      {
        referencesFile: async (fileId) => referenced.has(fileId),
      },
    ]);

    const deleteSpy = vi.spyOn(storage, "deleteUnattached").mockImplementation(async (_projectId, fileId) => {
      if (referenced.has(fileId)) {
        throw new AppError(409, "CONFLICT", "附件已被消息或画布使用，不能删除");
      }
      return true;
    });

    const result = await storage.gcUnattached({
      projectId: "p1",
      minAgeMs: 60 * 60 * 1000,
      now,
    });

    expect(selectResult.limit).toHaveBeenCalled();
    expect(deleteSpy).toHaveBeenCalledWith("p1", "old-orphan");
    expect(deleteSpy).toHaveBeenCalledWith("p1", "old-ref");
    expect(deleteSpy).not.toHaveBeenCalledWith("p1", "young-orphan");
    expect(result).toEqual({ scanned: 2, deleted: 1, skipped: 1, errors: 0 });
  });

  it("runs disk checkers before opening the delete transaction", async () => {
    const order: string[] = [];
    const db = {
      select: vi.fn(),
      transaction: vi.fn(async () => {
        order.push("transaction");
        return null;
      }),
    };
    const storage = new FileStorage(db as never, {
      uploadDir: "/tmp/qijian-test-uploads",
      publicBaseUrl: "http://localhost",
    } as never);
    storage.setReferenceCheckers([
      {
        transactional: false,
        referencesFile: async () => {
          order.push("disk");
          return true;
        },
      },
      {
        referencesFile: async () => {
          order.push("sql");
          return false;
        },
      },
    ]);

    await expect(storage.deleteUnattached("p1", "file-1")).rejects.toMatchObject({
      status: 409,
      code: "CONFLICT",
    });
    expect(order).toEqual(["disk"]);
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
