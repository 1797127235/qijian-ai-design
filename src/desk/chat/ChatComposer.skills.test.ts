import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChatComposer } from "./ChatComposer";

describe("ChatComposer skills entry", () => {
  it("renders skill button next to attach without category tabs", () => {
    const html = renderToStaticMarkup(createElement(ChatComposer, {
      input: "",
      setInput: vi.fn(),
      draftLocked: false,
      connection: "connected",
      busy: false,
      hasContent: false,
      attachmentsReady: true,
      items: [],
      fileInputRef: { current: null },
      inputRef: { current: null },
      onSubmit: vi.fn(),
      onStop: vi.fn(),
      onAddFiles: vi.fn(),
      onRetry: vi.fn(),
      onRemove: vi.fn(),
    }));
    expect(html).toContain('aria-label="添加附件"');
    expect(html).toContain('aria-label="技能"');
    expect(html).toContain("chat-input");
    expect(html).not.toContain("官方精选");
    expect(html).not.toContain("composer-skills-tab");
  });
});
