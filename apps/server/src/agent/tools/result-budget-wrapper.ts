import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ContextResourceStore } from "../context/resource-store.js";
import {
  applyTextResultBudget,
  measureToolResult,
  type ToolResultLike,
} from "./result-budget.js";

type AnyToolDefinition = ToolDefinition<any, any, any>;

function budgetMetrics(result: ToolResultLike): { truncated?: boolean } {
  const details = result.details;
  if (!details || typeof details !== "object") return {};
  const metrics = (details as { result_budget?: unknown }).result_budget;
  return metrics && typeof metrics === "object" ? metrics as { truncated?: boolean } : {};
}

export function budgetToolDefinition(
  tool: AnyToolDefinition,
  store: ContextResourceStore,
): AnyToolDefinition {
  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate, extensionContext) {
      const result = await tool.execute(toolCallId, params, signal, onUpdate, extensionContext);
      const inline = applyTextResultBudget(tool.name, result);
      if (!budgetMetrics(inline).truncated) return inline;
      let resourceRef: string | undefined;
      try {
        resourceRef = await store.putText(tool.name, measureToolResult(result).text);
      } catch {
        resourceRef = undefined;
      }
      return applyTextResultBudget(tool.name, result, { resourceRef });
    },
  };
}
