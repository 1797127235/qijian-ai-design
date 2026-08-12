import { describe, expect, it } from "vitest";
import { createDebugReturnImageTool, isDebugImageToolEnabled } from "./debug-return-image.js";

describe("debug_return_image", () => {
  it("returns text + image content with red png", async () => {
    const tool = createDebugReturnImageTool();
    expect(tool.name).toBe("debug_return_image");
    const result = await tool.execute("call-1", {}, undefined, undefined, {} as never);
    const parts = result.content;
    expect(parts.some((p) => p.type === "text")).toBe(true);
    const img = parts.find((p) => p.type === "image");
    expect(img).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(typeof (img as { data?: string }).data).toBe("string");
    expect((img as { data: string }).data.length).toBeGreaterThan(20);
    expect(result.details).toMatchObject({ ok: true, role: "probe" });
    expect(typeof (result.details as { color?: string }).color).toBe("string");
  });

  it("gates registration on AGENT_DEBUG_IMAGE_TOOL", () => {
    expect(isDebugImageToolEnabled({})).toBe(false);
    expect(isDebugImageToolEnabled({ AGENT_DEBUG_IMAGE_TOOL: "1" })).toBe(true);
    expect(isDebugImageToolEnabled({ AGENT_DEBUG_IMAGE_TOOL: "true" })).toBe(true);
    expect(isDebugImageToolEnabled({ AGENT_DEBUG_IMAGE_TOOL: "0" })).toBe(false);
  });
});
