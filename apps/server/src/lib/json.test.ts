import { describe, expect, it } from "vitest";
import { canonicalJson, contentHash } from "./json.js";

describe("canonical JSON", () => {
  it("sorts nested object keys without changing array order", () => {
    expect(canonicalJson({ z: [{ b: 2, a: 1 }], a: true })).toBe('{"a":true,"z":[{"a":1,"b":2}]}');
  });

  it("produces the same contract hash for equivalent payloads", () => {
    expect(contentHash({ needs: "收纳", style: "温暖" }, [])).toBe(contentHash({ style: "温暖", needs: "收纳" }, []));
  });
});
