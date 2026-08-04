import { describe, expect, it, vi } from "vitest";
import { PermissionGate } from "./permission-gate.js";
import type { DeskStateService } from "../services/desk-state-service.js";

function desks(permission: "ask" | "auto") {
  return { snapshot: vi.fn().mockResolvedValue({ project: { permission } }) } as unknown as DeskStateService;
}

describe("PermissionGate", () => {
  it("lets auto mode through without requesting approval", async () => {
    const emit = vi.fn();
    await new PermissionGate(desks("auto"), emit).check("project", "move_object", {}, "移动");
    expect(emit).not.toHaveBeenCalled();
  });

  it("waits for an ask-mode approval", async () => {
    const emit = vi.fn();
    const gate = new PermissionGate(desks("ask"), emit);
    const checking = gate.check("project", "confirm_artifact", { id: "one" }, "确认");
    await vi.waitFor(() => expect(emit).toHaveBeenCalledOnce());
    const event = emit.mock.calls[0][0] as { approvalId: string };
    expect(gate.resolve("project", event.approvalId, true)).toBe(true);
    await expect(checking).resolves.toBeUndefined();
  });

  it("never asks for read-only desk access", async () => {
    const emit = vi.fn();
    await new PermissionGate(desks("ask"), emit).check("project", "read_desk", {}, "读取");
    expect(emit).not.toHaveBeenCalled();
  });
});
