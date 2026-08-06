import { describe, expect, it } from "vitest";
import { assertConfirmable, DomainValidationError } from "./payload-rules.js";
import { findKeySpace, parseSpaces } from "./space-map.js";

describe("domain payload rules", () => {
  it("accepts regions alias for spaces", () => {
    expect(parseSpaces({ regions: [{ id: "living", key: true }] })).toEqual([
      { id: "living", key: true, raw: { id: "living", key: true } },
    ]);
    expect(findKeySpace({ spaces: [{ space_id: "kitchen", is_key_space: true }] }, "kitchen")?.id).toBe("kitchen");
  });

  it("requires selected direction among three cards", () => {
    expect(() => assertConfirmable("design_directions", {
      directions: [{ id: "a" }, { id: "b" }, { id: "c" }],
      selected_direction_id: null,
    })).toThrow(DomainValidationError);
  });

  it("requires mapped spaces before confirming a space map", () => {
    expect(() => assertConfirmable("space_map", { spaces: [] })).toThrow("必须标注空间区域");
  });
});
