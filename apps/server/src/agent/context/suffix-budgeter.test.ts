import { describe, expect, it } from "vitest";
import type { DeskManifestEntry } from "../desk-context.js";
import {
  MAX_DESK_FULL_CONTEXT_CHARS,
  budgetDeskFullContext,
} from "./suffix-budgeter.js";

function manifest(count: number): Record<string, DeskManifestEntry> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => {
    const id = `artifact-${String(index).padStart(4, "0")}-12345678-1234-1234-1234-123456789abc`;
    return [id, {
      id,
      alias: `A${String(index + 1).padStart(3, "0")}`,
      type: index % 3 === 0 ? "canvas_image" : "effect_image",
      label: `客厅方向 <${index}> & 暖木材质 ${"长".repeat(24)}`,
      lifecycle: index % 11 === 0 ? "pending" : "ready",
      grid: `@(${index % 10},${Math.floor(index / 10)})`,
      x: (index % 10) * 400,
      y: Math.floor(index / 10) * 400,
      fileId: `file-${index}`,
      edgesIn: index > 0 ? [`artifact-${String(index - 1).padStart(4, "0")}-12345678-1234-1234-1234-123456789abc`] : [],
      edgesOut: index < count - 1 ? [`artifact-${String(index + 1).padStart(4, "0")}-12345678-1234-1234-1234-123456789abc`] : [],
    } satisfies DeskManifestEntry];
  }));
}

describe("DeskFullSuffixBudgeter", () => {
  it("keeps a small full desk byte-for-byte", () => {
    const fullText = "[DESK_CONTEXT current=true revision=desk-1 objects=1]\n- A01 canvas_image art-1「客厅」 ready @(0,0)";
    const result = budgetDeskFullContext({
      revision: "desk-1",
      fullText,
      manifest: manifest(1),
      priorityArtifactIds: [],
    });

    expect(result.text).toBe(fullText);
    expect(result.metrics).toMatchObject({
      schema_version: 1,
      truncated: false,
      resource_status: "not_needed",
      original_text_chars: fullText.length,
      emitted_text_chars: fullText.length,
      total_objects: 1,
      emitted_objects: 1,
      omitted_objects: 0,
    });
  });

  it("prioritizes focus objects and enforces the hard limit after XML escaping", () => {
    const entries = manifest(140);
    const priorityId = Object.keys(entries).at(-1)!;
    const fullText = [
      "[DESK_CONTEXT current=true revision=desk-large objects=140 connections=139]",
      ...Object.values(entries).map((entry) => `${entry.alias} ${entry.id} ${entry.label} ${entry.lifecycle}`),
    ].join("\n");
    const resourceRef = `ctxres:sha256:${"b".repeat(64)}`;

    const first = budgetDeskFullContext({
      revision: "desk-large",
      fullText,
      manifest: entries,
      priorityArtifactIds: [priorityId],
      resourceRef,
    });
    const second = budgetDeskFullContext({
      revision: "desk-large",
      fullText,
      manifest: entries,
      priorityArtifactIds: [priorityId],
      resourceRef,
    });

    expect(first).toEqual(second);
    expect(first.text).toContain(priorityId);
    expect(first.text).toContain("[DESK_FULL_TRUNCATED]");
    expect(first.text).toContain(`resource_ref=${resourceRef}`);
    expect(first.text).toContain("next_cursor=0");
    expect(first.metrics.emitted_frame_chars).toBeLessThanOrEqual(MAX_DESK_FULL_CONTEXT_CHARS);
    expect(first.metrics).toMatchObject({
      truncated: true,
      resource_status: "stored",
      total_objects: 140,
      priority_objects: 1,
      resource_ref: resourceRef,
      next_cursor: "0",
    });
    expect(first.metrics.omitted_objects).toBeGreaterThan(0);
    expect(first.metrics.saved_frame_chars).toBeGreaterThan(0);
  });

  it("keeps the hard limit when resource persistence is unavailable", () => {
    const entries = manifest(140);
    const fullText = "<large & desk>".repeat(3_000);
    const result = budgetDeskFullContext({
      revision: "desk-large",
      fullText,
      manifest: entries,
      priorityArtifactIds: [],
    });

    expect(result.metrics.emitted_frame_chars).toBeLessThanOrEqual(MAX_DESK_FULL_CONTEXT_CHARS);
    expect(result.metrics).toMatchObject({
      truncated: true,
      resource_status: "unavailable",
    });
    expect(result.text).toContain("resource_status=unavailable");
    expect(result.text).not.toContain("next_cursor=0");
  });
});
