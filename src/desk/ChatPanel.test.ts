import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatPanel } from "./ChatPanel";

describe("ChatPanel", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows an enabled stop control while the assistant is busy", () => {
    vi.stubGlobal("window", {
      innerWidth: 1280,
      localStorage: { getItem: vi.fn().mockReturnValue(null), setItem: vi.fn() },
    });

    const html = renderToStaticMarkup(createElement(ChatPanel, {
      items: [],
      busy: true,
      connection: "connected",
      threads: [],
      threadChanging: false,
      onSend: vi.fn(),
      onStop: vi.fn(),
      onNewThread: vi.fn(),
      onSelectThread: vi.fn(),
      onDeleteThread: vi.fn(),
    }));

    expect(html).toContain('aria-label="停止生成"');
    expect(html).toMatch(/<button[^>]+class="send"[^>]+aria-label="停止生成"[^>]*>/);
    expect(html).not.toMatch(/<button[^>]+class="send"[^>]+disabled/);
  });
});
