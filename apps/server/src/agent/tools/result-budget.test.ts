import { describe, expect, it } from "vitest";
import {
  applyTextResultBudget,
  budgetPolicyFor,
  measureToolResult,
  resultBudgetOf,
} from "./result-budget.js";

describe("ToolResultBudget", () => {
  it("keeps small results byte-for-byte while attaching bounded metrics", () => {
    const result = {
      content: [{ type: "text" as const, text: "status=ready artifact_id=art-1" }],
      details: { ok: true, artifact_id: "art-1" },
    };

    const bounded = applyTextResultBudget("generate_from_desk", result);

    expect(bounded.content).toEqual(result.content);
    expect(bounded.details).toMatchObject({
      ok: true,
      artifact_id: "art-1",
      result_budget: {
        schema_version: 1,
        category: "control",
        truncated: false,
        original_text_chars: 30,
        emitted_text_chars: 30,
        saved_text_chars: 0,
      },
    });
  });

  it("replaces oversized text with a bounded preview and a stable resource reference", () => {
    const text = "记忆条目。".repeat(4_000);
    const image = { type: "image" as const, data: "a".repeat(128), mimeType: "image/png" };

    const bounded = applyTextResultBudget(
      "inspect_project_memory",
      {
        content: [{ type: "text" as const, text }, image],
        details: { ok: true, revision: 7 },
      },
      { resourceRef: "ctxres:sha256:0123456789abcdef" },
    );
    const emittedText = bounded.content
      .filter((item): item is { type: "text"; text: string } => item.type === "text")
      .map((item) => item.text)
      .join("\n");

    expect(emittedText.length).toBeLessThanOrEqual(budgetPolicyFor("inspect_project_memory", false).maxTextChars);
    expect(emittedText).toContain("resource_ref=ctxres:sha256:0123456789abcdef");
    expect(emittedText).toContain("next_cursor=0");
    expect(bounded.content).toContainEqual(image);
    expect(bounded.details).toMatchObject({
      ok: true,
      revision: 7,
      result_budget: {
        category: "retrieval",
        truncated: true,
        original_text_chars: text.length,
        image_count: 1,
        image_base64_chars: 128,
        resource_ref: "ctxres:sha256:0123456789abcdef",
      },
    });
    expect(resultBudgetOf(bounded)).toMatchObject({
      category: "retrieval",
      truncated: true,
      image_base64_chars: 128,
    });
  });

  it("uses the smaller failure budget and keeps failure facts", () => {
    const text = "provider failed ".repeat(500);
    const bounded = applyTextResultBudget(
      "generate_from_desk",
      {
        content: [{ type: "text" as const, text }],
        details: { ok: false, error_code: "PROVIDER_5XX", task_id: "task-1" },
      },
      { resourceRef: "ctxres:sha256:failure" },
    );

    expect(measureToolResult(bounded).textChars).toBeLessThanOrEqual(2_000);
    expect(bounded.details).toMatchObject({
      ok: false,
      error_code: "PROVIDER_5XX",
      task_id: "task-1",
      result_budget: { category: "error", truncated: true },
    });
  });
});
