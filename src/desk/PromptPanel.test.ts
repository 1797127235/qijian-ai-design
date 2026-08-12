import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PromptPanel } from "./PromptPanel";
import type { DeskObject } from "./types";

const source: DeskObject = {
  id: "a1",
  kind: "canvas_image",
  x: 0,
  y: 0,
  rot: 0,
  status: "draft",
};

describe("PromptPanel", () => {
  it("renders settings summary and send control", () => {
    const html = renderToStaticMarkup(
      createElement(PromptPanel, {
        source,
        references: [],
        onGenerate: () => undefined,
        onClose: () => undefined,
      }),
    );
    expect(html).toContain("desk-prompt-settings");
    expect(html).toContain("desk-prompt-send");
    expect(html).toContain("自动");
    expect(html).not.toContain("提示词库");
    // 模型列表异步拉取；初始无 models 时不渲染下拉
  });
});
