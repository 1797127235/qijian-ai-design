# 文档索引（以代码为准）

过期/历史文档**不要当现行规格**。实现冲突时：`CONTEXT.md` → `docs/adr/` 最新 → 代码。

## 现行（应读）

| 文档 | 用途 |
|------|------|
| [../CONTEXT.md](../CONTEXT.md) | 领域词汇 |
| [../README.md](../README.md) | 启动、能力、环境变量、工具白名单 |
| [../TODOS.md](../TODOS.md) | 产品/工程待办（主） |
| [../DESIGN.md](../DESIGN.md) | 设计系统 |
| [adr/0013-agent-generate-from-desk.md](adr/0013-agent-generate-from-desk.md) | Agent 写桌生图工具语义 |
| [adr/0014-bullmq-task-queue-for-asset-batches.md](adr/0014-bullmq-task-queue-for-asset-batches.md) | BullMQ 统一资产任务（BullMQ-only） |
| [adr/0015-image-task-safe-retry.md](adr/0015-image-task-safe-retry.md) | 生图安全有界重试（无查单/无网关幂等） |
| [ideas/image-task-safe-retry.md](ideas/image-task-safe-retry.md) | 0015 产品规格与上游实测 |
| [asset-task-queue-diagrams.md](asset-task-queue-diagrams.md) | BullMQ 任务架构图、流程图和时序图 |
| [runbooks/asset-task-queue.md](runbooks/asset-task-queue.md) | 队列运维：outbox、needs_review、重试、Bull Board、命名软失败 |
| [canvas-connections-generate-design.md](canvas-connections-generate-design.md) | 连线 + 面板生图 |
| [canvas-inpainting-design.md](canvas-inpainting-design.md) | 局部重绘 |
| [agent-desk-context-assembly.md](agent-desk-context-assembly.md) | 桌面上下文装配 |
| [intent/human-agent-desk-loop.md](intent/human-agent-desk-loop.md) | 人机同桌意图 |
| [dogfood/a101-day0.md](dogfood/a101-day0.md) | Day0 断点日志 |

## 历史 / 部分过期（只读）

| 文档 | 问题 |
|------|------|
| [adr/0012-agent-analysis-only.md](adr/0012-agent-analysis-only.md) | 已被 0013 覆盖 |
| [adr/0007](adr/0007-design-directions-as-comparable-artifact.md)–[0011](adr/0011-remove-design-brief.md) | 方向集/约束包等流水线已砍 |
| [canvas-toolbar-history-design.md](canvas-toolbar-history-design.md) | sticky_note 切片已砍 |
| [agent-desk-golden-tasks.md](agent-desk-golden-tasks.md) 等 agent-desk-* | 感知/字段目标；调度以 0014 为准 |
| [ideas/*](ideas/) | idea-refine 草稿 |
| **[archive/](archive/)** | 已迁走的 harness 审计、工具草案、superpowers specs/plans |

## 缺失引用（勿再链）

- `docs/canvas-workbench-design.md`
- `docs/implementation/agent-backend-redesign.md`
- `apps/server/src/agent/tools/generate-from-desk.ts` → `tools/generate/`
- `apps/server/src/agent/async-job/runner.ts` / `AgentJobRunner` → 已删；调度见 ADR 0014
- `ASYNC_JOB_BACKEND=legacy` → 已删

## 清理原则

1. 读文档只走「现行」表。  
2. 考古进 `archive/`，不删 ADR 0001–0011。  
3. 队列/迁移叙述以 **ADR 0014 + runbook** 为准，不看 archive 里的 PROPOSED 规格字面。  
