import { describe, expect, it } from "vitest";
import { createSearchToolsTool } from "./search-tools.js";
import type { ToolContext } from "./shared.js";

function textOf(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content.map((part) => ("text" in part ? part.text : "")).join("");
}

function mockSession(registry: string[], initialActive: string[]) {
  const active = new Set(initialActive);
  const allowed = new Set(registry);
  return {
    session: {
      getActiveToolNames: () => [...active],
      setActiveToolsByName: (names: string[]) => {
        active.clear();
        for (const name of names) {
          if (allowed.has(name)) active.add(name);
        }
      },
      agent: { state: { systemPrompt: "" } },
    },
    active,
  };
}

function toolFor(session: object) {
  return createSearchToolsTool({
    projectId: "p1",
    deps: {},
    agentSession: () => session,
    identityPrompt: () => "identity",
  } as unknown as ToolContext);
}

const baseActive = ["search_tools", "look_at", "look_at_desk"];

describe("search_tools activation", () => {
  it("activates matched desk tools when they are in the session registry", async () => {
    const { session, active } = mockSession(
      [...baseActive, "remove_from_desk", "generate_from_desk"],
      baseActive,
    );
    const result = await toolFor(session).execute("call-1", { query: "删除这张" }, undefined, undefined, {} as never);

    expect(result.details).toMatchObject({ ok: true });
    expect((result.details as { activated: string[] }).activated).toContain("remove_from_desk");
    expect(textOf(result)).toContain("remove_from_desk");
    expect([...active]).toContain("remove_from_desk");
  });

  it("fails once when matched tools cannot enter the registry allowlist", async () => {
    const { session } = mockSession(baseActive, baseActive);
    const result = await toolFor(session).execute("call-2", { query: "删除这张" }, undefined, undefined, {} as never);

    expect(result.details).toMatchObject({
      ok: false,
      reason: "activation_failed",
      failed: expect.arrayContaining(["remove_from_desk"]),
    });
    expect(textOf(result)).toContain("未能激活");
    expect(textOf(result)).toContain("勿重复 search_tools");
  });

  it("keeps partial activation when only some matches are in the registry", async () => {
    const { session, active } = mockSession(
      [...baseActive, "remove_from_desk"],
      baseActive,
    );
    const result = await toolFor(session).execute("call-3", { query: "删除桌面效果图" }, undefined, undefined, {} as never);

    expect(result.details).toMatchObject({ ok: true });
    expect((result.details as { activated: string[] }).activated).toContain("remove_from_desk");
    expect([...active]).toContain("remove_from_desk");
  });
});
