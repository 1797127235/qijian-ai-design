import { describe, expect, it, vi } from "vitest";
import { createGenerateHistoryGate } from "./recordGenerateOnce";

describe("createGenerateHistoryGate", () => {
  it("records only once per artifactId", () => {
    const gate = createGenerateHistoryGate();
    const record = vi.fn();
    const entry = {
      artifactId: "fx-1",
      artifactType: "effect_image" as const,
      payload: { pending: true },
      layout: { kind: "effect_image", x: 0, y: 0, rot: 0 },
    };
    const conn = { id: "c1", from: "a", to: "fx-1" };

    expect(gate.tryRecord("fx-1", record, entry, conn)).toBe(true);
    expect(gate.tryRecord("fx-1", record, entry, conn)).toBe(false);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({ type: "generate", entry, connections: [conn] });
  });

  it("reset clears seen ids", () => {
    const gate = createGenerateHistoryGate();
    const record = vi.fn();
    const entry = {
      artifactId: "fx-1",
      artifactType: "effect_image" as const,
      payload: {},
      layout: { kind: "effect_image", x: 0, y: 0, rot: 0 },
    };
    const conn = { id: "c1", from: "a", to: "fx-1" };
    gate.tryRecord("fx-1", record, entry, conn);
    gate.reset();
    expect(gate.tryRecord("fx-1", record, entry, conn)).toBe(true);
    expect(record).toHaveBeenCalledTimes(2);
  });
});
