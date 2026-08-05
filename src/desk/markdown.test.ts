import { describe, expect, it } from "vitest";
import { safeMarkdownUrl } from "./markdown";

describe("safeMarkdownUrl", () => {
  it("allows web, email, anchor, and local links", () => {
    expect(safeMarkdownUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(safeMarkdownUrl("mailto:designer@example.com")).toBe("mailto:designer@example.com");
    expect(safeMarkdownUrl("#section")).toBe("#section");
    expect(safeMarkdownUrl("/api/files/1")).toBe("/api/files/1");
  });

  it("rejects executable and protocol-relative URLs", () => {
    expect(safeMarkdownUrl("javascript:alert(1)")).toBe("");
    expect(safeMarkdownUrl("data:text/html,unsafe")).toBe("");
    expect(safeMarkdownUrl("//tracker.example/pixel")).toBe("");
  });
});
