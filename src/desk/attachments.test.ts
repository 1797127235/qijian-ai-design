import { describe, expect, it } from "vitest";
import { ATTACHMENT_ACCEPT, validateAttachmentFile } from "./attachments";

describe("attachment admission", () => {
  it("keeps the picker contract aligned with the backend", () => {
    expect(ATTACHMENT_ACCEPT).toBe(".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf");
  });

  it("rejects WebP, GIF and SVG before upload", () => {
    for (const type of ["image/webp", "image/gif", "image/svg+xml"]) {
      expect(validateAttachmentFile(new File(["x"], `sample.${type.split("/")[1]}`, { type }))).toBe("仅支持 PDF、JPG 和 PNG");
    }
  });
});
