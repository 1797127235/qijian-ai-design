import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

type TextBlock = { type: "text"; text: string };
type ImageBlock = { type: "image"; data: string; mimeType: string };

export type ToolResultLike<TDetails = unknown> = AgentToolResult<TDetails>;

export type ToolResultCategory = "control" | "retrieval" | "perception" | "error";

export type ToolResultBudgetMetrics = Readonly<{
  schema_version: 1;
  category: ToolResultCategory;
  max_text_chars: number;
  truncated: boolean;
  original_text_chars: number;
  emitted_text_chars: number;
  saved_text_chars: number;
  image_count: number;
  image_base64_chars: number;
  resource_ref?: string;
  next_cursor?: string;
}>;

const RETRIEVAL_TOOLS = new Set([
  "inspect_project_memory",
  "search_project_memory",
  "search_skills",
  "load_skill",
  "read_context_resource",
]);
const PERCEPTION_TOOLS = new Set(["look_at", "look_at_desk"]);

function detailRecord(details: unknown): Record<string, unknown> {
  return details && typeof details === "object" && !Array.isArray(details)
    ? details as Record<string, unknown>
    : {};
}

function isFailure(details: unknown): boolean {
  const record = detailRecord(details);
  return record.ok === false || record.status === "failed" || record.status === "error";
}

export function budgetPolicyFor(toolName: string, failed: boolean): {
  category: ToolResultCategory;
  maxTextChars: number;
} {
  if (failed) return { category: "error", maxTextChars: 2_000 };
  if (PERCEPTION_TOOLS.has(toolName)) return { category: "perception", maxTextChars: 4_000 };
  if (RETRIEVAL_TOOLS.has(toolName)) return { category: "retrieval", maxTextChars: 6_000 };
  return { category: "control", maxTextChars: 1_500 };
}

export function measureToolResult(result: ToolResultLike): {
  text: string;
  textChars: number;
  imageCount: number;
  imageBase64Chars: number;
} {
  const text = result.content
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const images = result.content.filter((block): block is ImageBlock => block.type === "image");
  return {
    text,
    textChars: text.length,
    imageCount: images.length,
    imageBase64Chars: images.reduce((sum, image) => sum + image.data.length, 0),
  };
}

export function resultBudgetOf(result: unknown): ToolResultBudgetMetrics | undefined {
  if (!result || typeof result !== "object") return undefined;
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const metrics = (details as { result_budget?: unknown }).result_budget;
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return undefined;
  return (metrics as { schema_version?: unknown }).schema_version === 1
    ? metrics as ToolResultBudgetMetrics
    : undefined;
}

export function applyTextResultBudget<TDetails>(
  toolName: string,
  result: ToolResultLike<TDetails>,
  options: { resourceRef?: string } = {},
): ToolResultLike<Record<string, unknown> & { result_budget: ToolResultBudgetMetrics }> {
  const measured = measureToolResult(result);
  const policy = budgetPolicyFor(toolName, isFailure(result.details));
  const truncated = measured.textChars > policy.maxTextChars;
  let content = result.content;
  if (truncated) {
    const marker = [
      "[TOOL_RESULT_TRUNCATED]",
      ...(options.resourceRef
        ? [`resource_ref=${options.resourceRef}`, "next_cursor=0"]
        : ["resource_status=unavailable"]),
      `original_text_chars=${measured.textChars}`,
    ].join("\n");
    const previewChars = Math.max(0, policy.maxTextChars - marker.length - 2);
    const text = `${measured.text.slice(0, previewChars)}\n\n${marker}`;
    content = [
      { type: "text", text },
      ...result.content.filter((block): block is ImageBlock => block.type === "image"),
    ];
  }
  const emitted = measureToolResult({ ...result, content });
  const metrics: ToolResultBudgetMetrics = Object.freeze({
    schema_version: 1,
    category: policy.category,
    max_text_chars: policy.maxTextChars,
    truncated,
    original_text_chars: measured.textChars,
    emitted_text_chars: emitted.textChars,
    saved_text_chars: measured.textChars - emitted.textChars,
    image_count: measured.imageCount,
    image_base64_chars: measured.imageBase64Chars,
    ...(truncated && options.resourceRef ? { resource_ref: options.resourceRef, next_cursor: "0" } : {}),
  });
  return {
    ...result,
    content,
    details: { ...detailRecord(result.details), result_budget: metrics },
  };
}
