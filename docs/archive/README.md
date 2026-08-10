# 文档归档

**不要当现行规格。** 实现以 `CONTEXT.md`、`docs/adr/` 最新、`docs/runbooks/` 与代码为准。

## 内容

| 路径 | 原用途 | 为何归档 |
|------|--------|----------|
| `audits/agent-harness-audit.md` | Harness 审计 | 仍写 `AgentJobRunner` / 旧路径 |
| `audits/agent-tools-optimal-redesign.md` | 工具表草案 | 路径与调度过时；以 ADR 0013/0014 为准 |
| `audits/agent-design-frontier-review.md` | 前沿评审 | sticky_note / 分析-only 等已砍 |
| `superpowers/specs/*` | 阶段规格 | 含 H8 / 框选等已落地或被 0014 取代的设计 |
| `superpowers/plans/*` | 实施计划 | 已完成或路径失效 |

统一资产队列现行文档：

- [ADR 0014](../adr/0014-bullmq-task-queue-for-asset-batches.md)
- [Runbook](../runbooks/asset-task-queue.md)
- 规格原稿（考古）：`superpowers/specs/2026-08-10-unified-asset-task-queue-design.md`（状态仍为 PROPOSED 字样，**以 ADR 0014 完成态为准**）
