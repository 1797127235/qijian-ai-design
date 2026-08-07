import { describe, expect, it } from "vitest";
import { assertPayload, DomainValidationError } from "./payload-rules.js";

describe("assertPayload", () => {
  it("accepts empty sticky notes (create-then-edit flow)", () => {
    expect(() => assertPayload("sticky_note", {})).not.toThrow();
    expect(() => assertPayload("sticky_note", { text: "" })).not.toThrow();
    expect(() => assertPayload("sticky_note", { text: "hello" })).not.toThrow();
  });

  it("rejects non-string sticky note text", () => {
    expect(() => assertPayload("sticky_note", { text: 42 })).toThrow("便签内容必须是文本");
  });

  it("accepts empty canvas_image placeholders (create-then-fill flow)", () => {
    expect(() => assertPayload("canvas_image", {})).not.toThrow();
  });

  it("accepts pending canvas_image without file_id", () => {
    expect(() => assertPayload("canvas_image", { pending: true, prompt: "x" })).not.toThrow();
  });

  it("accepts failed canvas_image without file_id", () => {
    expect(() => assertPayload("canvas_image", { error: "timeout", pending: false })).not.toThrow();
  });

  it("rejects blank canvas_image file_id", () => {
    expect(() => assertPayload("canvas_image", { file_id: "  " })).toThrow("不能为空字符串");
  });

  it("rejects completed canvas_image without file_id", () => {
    expect(() => assertPayload("canvas_image", { pending: false })).toThrow("完成态必须包含 file_id");
  });

  it("accepts canvas images with file_id", () => {
    expect(() => assertPayload("canvas_image", { file_id: "3f6b9c2e-1234-4abc-9def-1234567890ab" })).not.toThrow();
  });

  it("accepts pending effect_image without file_id", () => {
    expect(() => assertPayload("effect_image", { pending: true, prompt: "x" })).not.toThrow();
  });

  it("accepts failed effect_image without file_id", () => {
    expect(() => assertPayload("effect_image", { error: "timeout", pending: false })).not.toThrow();
  });

  it("rejects completed effect_image without file_id", () => {
    expect(() => assertPayload("effect_image", { pending: false })).toThrow("必须包含 file_id");
  });

  it("accepts completed effect_image with file_id", () => {
    expect(() => assertPayload("effect_image", { file_id: "3f6b9c2e-1234-4abc-9def-1234567890ab", pending: false })).not.toThrow();
  });
});
