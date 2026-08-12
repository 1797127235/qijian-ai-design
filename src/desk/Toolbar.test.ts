import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DeskToolbar } from "./Toolbar";

const base = {
  onHand: () => undefined,
  onUndo: () => undefined,
  onRedo: () => undefined,
  onImage: () => undefined,
};

describe("DeskToolbar", () => {
  it("renders tools in order without text tool", () => {
    const html = renderToStaticMarkup(createElement(DeskToolbar, { ...base, canUndo: false, canRedo: false }));
    const order = ["漫游", "撤销", "重做", "图片"].map((label) => html.indexOf(`aria-label="${label}"`));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).not.toContain('aria-label="文字"');
  });

  it("disables undo/redo when nothing can be undone or redone", () => {
    const html = renderToStaticMarkup(createElement(DeskToolbar, { ...base, canUndo: false, canRedo: false }));
    expect(html).toMatch(/aria-label="撤销"[^>]*disabled/);
    expect(html).toMatch(/aria-label="重做"[^>]*disabled/);
  });

  it("enables undo/redo when history exists", () => {
    const html = renderToStaticMarkup(createElement(DeskToolbar, { ...base, canUndo: true, canRedo: true }));
    expect(html).not.toMatch(/aria-label="撤销"[^>]*disabled/);
    expect(html).not.toMatch(/aria-label="重做"[^>]*disabled/);
  });
});
