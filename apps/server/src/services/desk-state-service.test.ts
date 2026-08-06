import { describe, expect, it } from "vitest";
import { normalizeConnection } from "./desk-state-service.js";

describe("normalizeConnection", () => {
  const objects = new Set(["a", "b", "c"]);

  it("rejects self links", () => {
    expect(normalizeConnection("a", "a", [], objects)).toEqual({ ok: false, reason: "不能连接到自身" });
  });

  it("rejects missing endpoints", () => {
    expect(normalizeConnection("a", "missing", [], objects)).toEqual({ ok: false, reason: "连线端点不在桌面上" });
  });

  it("returns existing connection for duplicates", () => {
    const existing = [{ id: "c1", from: "a", to: "b" }];
    const result = normalizeConnection("a", "b", existing, objects);
    expect(result).toEqual({ ok: true, existing: existing[0] });
  });

  it("creates a new connection when valid", () => {
    const result = normalizeConnection("a", "b", [], objects);
    expect(result.ok).toBe(true);
    if (result.ok && result.connection) {
      expect(result.connection.from).toBe("a");
      expect(result.connection.to).toBe("b");
      expect(result.connection.id).toMatch(/^[0-9a-f-]{36}$/i);
    }
  });
});
