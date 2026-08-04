import { randomUUID } from "node:crypto";
import type { DeskStateService } from "../services/desk-state-service.js";
import type { EventSink } from "./events.js";

interface PendingApproval {
  projectId: string;
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
}

export class PermissionGate {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(private readonly desks: DeskStateService, private readonly emit: EventSink) {}

  async check(projectId: string, tool: string, params: unknown, description: string, signal?: AbortSignal) {
    const { project } = await this.desks.snapshot(projectId);
    if (project.permission === "auto" || tool === "read_desk") return;
    const approvalId = randomUUID();
    const approved = await new Promise<boolean>((resolve) => {
      const finish = (result: boolean) => {
        const item = this.pending.get(approvalId);
        if (item) clearTimeout(item.timer);
        this.pending.delete(approvalId);
        resolve(result);
      };
      const timer = setTimeout(() => finish(false), 5 * 60_000);
      this.pending.set(approvalId, { projectId, resolve: finish, timer });
      signal?.addEventListener("abort", () => finish(false), { once: true });
      this.emit({ type: "approval_request", projectId, approvalId, tool, params, description });
    });
    this.emit({ type: "approval_resolved", projectId, approvalId, approved });
    if (!approved) throw new Error(`用户拒绝执行：${description}`);
  }

  resolve(projectId: string, approvalId: string, approved: boolean) {
    const item = this.pending.get(approvalId);
    if (!item || item.projectId !== projectId) return false;
    item.resolve(approved);
    return true;
  }
}
