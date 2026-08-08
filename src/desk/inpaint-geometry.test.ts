import { describe, expect, it } from "vitest";
import { normalizeRect } from "./inpaint-geometry";

describe("normalizeRect", () => {
  const size = { w: 400, h: 300 };

  it("两点转归一化 rect（与拖拽方向无关）", () => {
    expect(normalizeRect({ x: 100, y: 75 }, { x: 200, y: 150 }, size)).toEqual({
      x: 0.25, y: 0.25, w: 0.25, h: 0.25,
    });
    expect(normalizeRect({ x: 200, y: 150 }, { x: 100, y: 75 }, size)).toEqual({
      x: 0.25, y: 0.25, w: 0.25, h: 0.25,
    });
  });

  it("拖出节点边界时 clamp 到图内", () => {
    const r = normalizeRect({ x: -50, y: -50 }, { x: 500, y: 400 }, size);
    expect(r).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it("小于 2% 面积视为误触，返回 undefined", () => {
    expect(normalizeRect({ x: 0, y: 0 }, { x: 3, y: 300 }, size)).toBeUndefined(); // 0.75% 宽
    expect(normalizeRect({ x: 0, y: 0 }, { x: 400, y: 3 }, size)).toBeUndefined(); // 1% 高
  });

  it("恰好 2% 边界可用", () => {
    const r = normalizeRect({ x: 0, y: 0 }, { x: 8, y: 300 }, size);
    expect(r).toEqual({ x: 0, y: 0, w: 0.02, h: 1 });
  });
});
