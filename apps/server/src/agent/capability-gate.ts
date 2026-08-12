import { AsyncLocalStorage } from "node:async_hooks";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export type TurnContext = Readonly<{
  projectId: string;
  threadId: string;
  runId: string;
  source: "interactive" | "job_event";
  mode: "designer" | "wake";
  authority: "user_explicit" | "system_event";
  policyRevision: string;
  selectedArtifactIds: readonly string[];
}>;

export type CapabilityDecision =
  | Readonly<{ allowed: true; policyRevision: string }>
  | Readonly<{
    allowed: false;
    code: "WAKE_READ_ONLY";
    reason: string;
    policyRevision: string;
  }>;

const WAKE_READ_TOOLS = new Set([
  "look_at",
  "look_at_desk",
  "get_task",
  "inspect_project_memory",
  "search_project_memory",
  "load_skill",
  "read_context_resource",
]);

export class TurnContextScope {
  private readonly storage = new AsyncLocalStorage<TurnContext>();

  run<T>(context: TurnContext, operation: () => T): T {
    return this.storage.run(context, operation);
  }

  current(): TurnContext {
    const context = this.storage.getStore();
    if (!context) throw new Error("agent turn context is unavailable");
    return context;
  }

  maybeCurrent(): TurnContext | undefined {
    return this.storage.getStore();
  }
}

export class CapabilityGate {
  decide(context: TurnContext, toolName: string): CapabilityDecision {
    if (context.mode === "designer" || WAKE_READ_TOOLS.has(toolName)) {
      return { allowed: true, policyRevision: context.policyRevision };
    }
    return {
      allowed: false,
      code: "WAKE_READ_ONLY",
      reason: "当前轮次用于读取并汇报后台任务结果；新的用户操作请求会开启可执行轮次。",
      policyRevision: context.policyRevision,
    };
  }
}

type AnyToolDefinition = ToolDefinition<any, any, any>;

export function guardToolDefinition(
  tool: AnyToolDefinition,
  scope: TurnContextScope,
  gate: CapabilityGate,
): AnyToolDefinition {
  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate, extensionContext) {
      const context = scope.current();
      const decision = gate.decide(context, tool.name);
      if (!decision.allowed) {
        return {
          content: [{ type: "text", text: decision.reason }],
          details: {
            ok: false,
            error: decision.reason,
            error_code: "POLICY_DENIED",
            code: decision.code,
            tool_name: tool.name,
            policy_revision: decision.policyRevision,
          },
        };
      }
      return tool.execute(toolCallId, params, signal, onUpdate, extensionContext);
    },
  };
}
