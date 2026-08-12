import { createHash } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { SessionToolStateSnapshot } from "./tools/session-tool-state.js";

export type CacheFingerprint = Readonly<{
  systemSha256: string;
  toolsSha256: string;
  historyPrefixSha256: string;
  activeToolCount: number;
  historyMessageCount: number;
  toolEpoch: number;
  workingSetSha256: string;
  workingSetSize: number;
  frameSha256: string;
  trajectoryEpoch: number;
}>;

function canonicalValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item, seen) ?? null);
  if (typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = canonicalValue((value as Record<string, unknown>)[key], seen);
      if (child !== undefined) result[key] = child;
    }
    seen.delete(value);
    return result;
  }
  return String(value);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value, new WeakSet())) ?? "null";
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(
    typeof value === "string" ? value : canonicalJson(value),
  ).digest("hex");
}

export function fingerprintAgentContext(
  session: AgentSession,
  toolState?: SessionToolStateSnapshot,
  frameSha256 = sha256(""),
  trajectoryEpoch = 1,
): CacheFingerprint {
  const activeNames = session.getActiveToolNames();
  const tools = activeNames.map((name) => {
    const definition = session.getToolDefinition(name);
    return {
      name,
      description: definition?.description,
      parameters: definition?.parameters,
      constrainedSampling: definition?.constrainedSampling,
    };
  });
  return {
    systemSha256: sha256(session.systemPrompt),
    toolsSha256: sha256(tools),
    historyPrefixSha256: sha256(session.messages),
    activeToolCount: activeNames.length,
    historyMessageCount: session.messages.length,
    toolEpoch: toolState?.toolEpoch ?? 1,
    workingSetSha256: sha256(toolState?.workingSet ?? []),
    workingSetSize: toolState?.workingSet.length ?? 0,
    frameSha256,
    trajectoryEpoch,
  };
}

export class CacheContract {
  private readonly systemBySession = new WeakMap<AgentSession, string>();

  /**
   * @param onViolation `throw`：请求前硬校验；`accept`：请求后只记录并接受新前缀（避免成功对话被收尾打成失败）
   */
  observe(
    session: AgentSession,
    toolState?: SessionToolStateSnapshot,
    options: { onViolation?: "throw" | "accept" } = {},
  ): CacheFingerprint {
    const fingerprint = fingerprintAgentContext(session, toolState);
    const expected = this.systemBySession.get(session);
    if (expected && expected !== fingerprint.systemSha256) {
      const message =
        `system prefix changed within session: expected ${expected}, received ${fingerprint.systemSha256}`;
      if ((options.onViolation ?? "throw") === "throw") throw new Error(message);
      console.warn(`[cache-contract] ${message}`);
    }
    this.systemBySession.set(session, fingerprint.systemSha256);
    return fingerprint;
  }
}
