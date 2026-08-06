import { describe, expect, it } from "vitest";
import { assertPayload, DomainValidationError } from "./payload-rules.js";

describe("assertPayload", () => {
  it("rejects empty understanding notes", () => {
    expect(() => assertPayload("understanding_note", { text: "  " })).toThrow(DomainValidationError);
  });

  it("rejects empty design direction sets", () => {
    expect(() => assertPayload("design_directions", { directions: [] })).toThrow("至少包含一个方向");
  });

  it("accepts design directions without selection", () => {
    expect(() => assertPayload("design_directions", {
      directions: [{ id: "a" }],
    })).not.toThrow();
  });

  it("rejects effect images without url", () => {
    expect(() => assertPayload("effect_image", {})).toThrow("必须包含图片 URL");
  });

  it("accepts empty sticky notes (create-then-edit flow)", () => {
    expect(() => assertPayload("sticky_note", {})).not.toThrow();
    expect(() => assertPayload("sticky_note", { text: "" })).not.toThrow();
    expect(() => assertPayload("sticky_note", { text: "hello" })).not.toThrow();
  });

  it("rejects non-string sticky note text", () => {
    expect(() => assertPayload("sticky_note", { text: 42 })).toThrow("便签内容必须是文本");
  });

  it("rejects canvas images without file_id", () => {
    expect(() => assertPayload("canvas_image", {})).toThrow("必须包含 file_id");
    expect(() => assertPayload("canvas_image", { file_id: "  " })).toThrow("必须包含 file_id");
  });

  it("accepts canvas images with file_id", () => {
    expect(() => assertPayload("canvas_image", { file_id: "3f6b9c2e-1234-4abc-9def-1234567890ab" })).not.toThrow();
  });
});
