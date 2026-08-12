import { describe, expect, it } from "vitest";
import { createSearchToolsTool } from "./search-tools.js";
import type { ToolContext } from "./shared.js";
import { orderAdditiveTools } from "./session-tool-state.js";

function textOf(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content.map((part) => ("text" in part ? part.text : "")).join("");
}

function mockSession(registry: string[], initialActive: string[]) {
  const active = new Set(initialActive);
  const allowed = new Set(registry);
  const systemPrompt = "stable-system";
  return {
    session: {
      getActiveToolNames: () => [...active],
      setActiveToolsByName: (names: string[]) => {
        active.clear();
        for (const name of names) {
          if (allowed.has(name)) active.add(name);
        }
      },
      agent: { state: { systemPrompt } },
    },
    active,
    systemPrompt,
  };
}

function toolFor(session: object, registryOrder = [
  "search_tools",
  "look_at",
  "look_at_desk",
  "generate_from_desk",
  "remove_from_desk",
]) {
  const activeSets: string[][] = [];
  const discoveredSets: string[][] = [];
  const tool = createSearchToolsTool({
    projectId: "p1",
    deps: {},
    agentSession: () => session,
    toolState: () => ({
      orderAdditions: (current: string[], additions: string[]) => orderAdditiveTools(
        current,
        additions,
        registryOrder,
      ),
      recordActiveSet: (names: string[]) => activeSets.push([...names]),
      recordDiscovery: (names: string[]) => discoveredSets.push([...names]),
    }),
  } as unknown as ToolContext);
  return { tool, activeSets, discoveredSets };
}

const baseActive = ["search_tools", "look_at", "look_at_desk"];

describe("search_tools activation", () => {
  it("activates matched desk tools when they are in the session registry", async () => {
    const { session, active, systemPrompt } = mockSession(
      [...baseActive, "remove_from_desk", "generate_from_desk"],
      baseActive,
    );
    const result = await toolFor(session).tool.execute("call-1", { query: "删除这张" }, undefined, undefined, {} as never);

    expect(result.details).toMatchObject({ ok: true });
    expect((result.details as { activated: string[] }).activated).toContain("remove_from_desk");
    expect(textOf(result)).toContain("remove_from_desk");
    expect([...active]).toContain("remove_from_desk");
    expect((session as { agent: { state: { systemPrompt: string } } }).agent.state.systemPrompt).toBe(systemPrompt);
  });

  it("fails once when matched tools cannot enter the registry allowlist", async () => {
    const { session } = mockSession(baseActive, baseActive);
    const result = await toolFor(session).tool.execute("call-2", { query: "删除这张" }, undefined, undefined, {} as never);

    expect(result.details).toMatchObject({
      ok: false,
      reason: "activation_failed",
      failed: expect.arrayContaining(["remove_from_desk"]),
    });
    expect(textOf(result)).toContain("未能激活");
    expect(textOf(result)).toContain("直接向用户说明");
  });

  it("keeps partial activation when only some matches are in the registry", async () => {
    const { session, active } = mockSession(
      [...baseActive, "remove_from_desk"],
      baseActive,
    );
    const result = await toolFor(session).tool.execute("call-3", { query: "删除桌面效果图" }, undefined, undefined, {} as never);

    expect(result.details).toMatchObject({ ok: true });
    expect((result.details as { activated: string[] }).activated).toContain("remove_from_desk");
    expect([...active]).toContain("remove_from_desk");
  });

  it("uses the session registry order and records the resulting active set", async () => {
    const { session } = mockSession(
      [...baseActive, "remove_from_desk", "generate_from_desk"],
      baseActive,
    );
    const { tool, activeSets, discoveredSets } = toolFor(session, [
      ...baseActive,
      "remove_from_desk",
      "generate_from_desk",
    ]);

    const result = await tool.execute(
      "call-4",
      { query: "删除桌面效果图" },
      undefined,
      undefined,
      {} as never,
    );

    expect(result.details).toMatchObject({ ok: true });
    expect((result.details as { active_tools: string[] }).active_tools).toEqual([
      ...baseActive,
      "remove_from_desk",
      "generate_from_desk",
    ]);
    expect(activeSets).toEqual([[
      ...baseActive,
      "remove_from_desk",
      "generate_from_desk",
    ]]);
    expect(discoveredSets).toEqual([[
      "generate_from_desk",
      "remove_from_desk",
    ]]);
  });
});
