import { describe, expect, it } from "vitest";
import {
  heuristicDisplayNameFromPrompt,
  sanitizeDisplayName,
} from "./artifact-display-namer.js";

describe("sanitizeDisplayName", () => {
  it("keeps short Chinese labels", () => {
    expect(sanitizeDisplayName("客厅 · 暖木")).toBe("客厅 · 暖木");
  });

  it("rejects lineage and machine ids", () => {
    expect(sanitizeDisplayName("从客厅生成")).toBeUndefined();
    expect(sanitizeDisplayName("A07")).toBeUndefined();
  });
});

describe("heuristicDisplayNameFromPrompt", () => {
  it("builds plan + 彩平 from colored floor-plan intent", () => {
    const name = heuristicDisplayNameFromPrompt(
      "将这张三室一厅线稿户型图转为专业彩色平面图（严格2D俯视彩平，非透视）。",
    );
    expect(name).toBe("三室一厅彩平");
  });

  it("builds plan + 线稿户型 from line-plan intent", () => {
    const name = heuristicDisplayNameFromPrompt(
      "重新绘制专业三室一厅住宅户型线稿平面图（严格2D俯视黑白线稿，非透视非彩平）。约118㎡",
    );
    expect(name).toBe("三室一厅线稿户型");
  });

  it("builds room · style for interior render", () => {
    const name = heuristicDisplayNameFromPrompt(
      "根据一层平面图生成厨房室内透视效果图。风格严格为「粗野触感」家装尺度。",
    );
    expect(name).toBe("厨房 · 粗野触感");
  });

  it("reads 意图： body after 参考话题 wrapper", () => {
    const name = heuristicDisplayNameFromPrompt(
      "参考话题：旧客厅\n意图：生成客厅暖木效果图",
    );
    expect(name).toBe("客厅 · 暖木");
  });

  it("returns undefined for empty noise", () => {
    expect(heuristicDisplayNameFromPrompt("   ")).toBeUndefined();
    expect(heuristicDisplayNameFromPrompt("ok")).toBeUndefined();
  });
});
