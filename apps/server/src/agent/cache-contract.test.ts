import { describe, expect, it } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { CacheContract, fingerprintAgentContext, sha256 } from "./cache-contract.js";

function fakeSession(overrides: Partial<{
  systemPrompt: string;
  tools: string[];
  messages: unknown[];
}> = {}): AgentSession {
  const systemPrompt = overrides.systemPrompt ?? "stable-system";
  const tools = overrides.tools ?? ["search_tools", "look_at"];
  const messages = overrides.messages ?? [{ role: "user", content: "hello" }];
  return {
    get systemPrompt() { return systemPrompt; },
    get messages() { return messages; },
    getActiveToolNames: () => tools,
    getToolDefinition: (name: string) => ({
      name,
      description: `${name} description`,
      parameters: { type: "object", properties: {} },
    }),
  } as unknown as AgentSession;
}

describe("CacheContract", () => {
  it("canonicalizes object key order before hashing", () => {
    expect(sha256({ b: 2, a: 1 })).toBe(sha256({ a: 1, b: 2 }));
  });

  it("produces deterministic hashes and preserves tool order", () => {
    const first = fingerprintAgentContext(fakeSession());
    const second = fingerprintAgentContext(fakeSession());
    const reordered = fingerprintAgentContext(fakeSession({ tools: ["look_at", "search_tools"] }));

    expect(first).toEqual(second);
    expect(reordered.toolsSha256).not.toBe(first.toolsSha256);
  });

  it("carries the canonical current-frame fingerprint", () => {
    const fingerprint = fingerprintAgentContext(fakeSession(), undefined, "frame-sha-1");
    expect(fingerprint.frameSha256).toBe("frame-sha-1");
  });

  it("rejects a system prefix change within one session", () => {
    let systemPrompt = "stable-system";
    const session = {
      get systemPrompt() { return systemPrompt; },
      get messages() { return []; },
      getActiveToolNames: () => ["search_tools"],
      getToolDefinition: () => undefined,
    } as unknown as AgentSession;
    const contract = new CacheContract();

    contract.observe(session);
    systemPrompt = "changed-system";

    expect(() => contract.observe(session)).toThrow(/system prefix changed/i);
  });

  it("can accept a system prefix change without throwing", () => {
    let systemPrompt = "stable-system";
    const session = {
      get systemPrompt() { return systemPrompt; },
      get messages() { return []; },
      getActiveToolNames: () => ["search_tools"],
      getToolDefinition: () => undefined,
    } as unknown as AgentSession;
    const contract = new CacheContract();

    contract.observe(session);
    systemPrompt = "changed-system";
    const fingerprint = contract.observe(session, undefined, { onViolation: "accept" });
    expect(fingerprint.systemSha256).toBe(sha256("changed-system"));
  });
});
