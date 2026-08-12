import { describe, expect, it } from "vitest";
import { formatSizeLabel, resolveRequestSize } from "./image-size.js";

describe("resolveRequestSize", () => {
  it("omits empty and auto", () => {
    expect(resolveRequestSize(undefined)).toBeUndefined();
    expect(resolveRequestSize("")).toBeUndefined();
    expect(resolveRequestSize("auto")).toBeUndefined();
    expect(resolveRequestSize("AUTO")).toBeUndefined();
  });

  it("passes through valid WxH", () => {
    expect(resolveRequestSize("1024x1024")).toBe("1024x1024");
    expect(resolveRequestSize("1824x1024")).toBe("1824x1024");
  });

  it("maps common ratios to 16-aligned pixels", () => {
    expect(resolveRequestSize("1:1")).toBe("1024x1024");
    expect(resolveRequestSize("16:9")).toMatch(/^\d+x\d+$/);
    const wide = resolveRequestSize("16:9")!;
    const [w, h] = wide.split("x").map(Number);
    expect(w).toBeGreaterThan(h);
    expect(w % 16).toBe(0);
    expect(h % 16).toBe(0);
  });

  it("returns undefined for garbage (no throw)", () => {
    expect(resolveRequestSize("nope")).toBeUndefined();
    expect(resolveRequestSize("12")).toBeUndefined();
  });

  it("does not treat invalid ratios as 1:1", () => {
    expect(resolveRequestSize("foo:bar")).toBeUndefined();
    expect(resolveRequestSize("0:1")).toBeUndefined();
    expect(resolveRequestSize("1:0")).toBeUndefined();
    expect(resolveRequestSize(":")).toBeUndefined();
  });
});

describe("formatSizeLabel", () => {
  it("labels auto", () => {
    expect(formatSizeLabel(undefined)).toBe("自动");
    expect(formatSizeLabel("auto")).toBe("自动");
  });
});
