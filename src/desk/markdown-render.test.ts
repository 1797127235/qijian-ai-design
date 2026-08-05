import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownMessage } from "./ChatPanel";

describe("MarkdownMessage", () => {
  it("renders common assistant formatting", () => {
    const text = [
      "**重点空间**",
      "",
      "1. 客厅",
      "2. 餐厅",
      "",
      "| 区域 | 状态 |",
      "| --- | --- |",
      "| 客厅 | 已确认 |",
      "",
      "```json",
      '{"ok":true}',
      "```",
    ].join("\n");
    const html = renderToStaticMarkup(createElement(MarkdownMessage, { text }));

    expect(html).toContain("<strong>重点空间</strong>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<table>");
    expect(html).toContain("<pre>");
  });

  it("drops raw HTML and executable links", () => {
    const text = '<script>alert(1)</script>\n\n[危险链接](javascript:alert(1))';
    const html = renderToStaticMarkup(createElement(MarkdownMessage, { text }));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("javascript:");
  });
});
