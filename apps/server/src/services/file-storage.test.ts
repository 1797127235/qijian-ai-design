import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { AppError } from "../lib/errors.js";
import { inspectUpload } from "./file-storage.js";

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
