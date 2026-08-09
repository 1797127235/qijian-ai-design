# 文档索引（以代码为准）

过期/历史文档**不要当现行规格**。实现冲突时：`CONTEXT.md` → `docs/adr/` 最新 → 代码。

## 现行（应读）

| 文档 | 用途 |
|------|------|
| [../CONTEXT.md](../CONTEXT.md) | 领域词汇 |
| [../README.md](../README.md) | 启动、能力、环境变量、工具白名单 |
| [../TODOS.md](../TODOS.md) | 产品/工程待办（主） |
| [../DESIGN.md](../DESIGN.md) | 设计系统 |
| [adr/0013-agent-generate-from-desk.md](adr/0013-agent-generate-from-desk.md) | Agent 写桌生图（现行） |
| [canvas-connections-generate-design.md](canvas-connections-generate-design.md) | 连线 + 面板生图（大体仍准） |
| [canvas-inpainting-design.md](canvas-inpainting-design.md) | 局部重绘 |
| [agent-desk-context-assembly.md](agent-desk-context-assembly.md) | 桌面上下文装配 |
| [intent/human-agent-desk-loop.md](intent/human-agent-desk-loop.md) | 人机同桌意图 |
| [dogfood/a101-day0.md](dogfood/a101-day0.md) | Day0 断点日志 |

## 历史 / 部分过期（只读勿当规格）

| 文档 | 问题 |
|------|------|
| [adr/0012-agent-analysis-only.md](adr/0012-agent-analysis-only.md) | 已被 0013 覆盖；「永不写桌」作废 |
| [adr/0007](adr/0007-design-directions-as-comparable-artifact.md)–[0011](adr/0011-remove-design-brief.md) | 方向集/约束包/提案画布等流水线，产品已砍 |
| [agent-design-frontier-review.md](agent-design-frontier-review.md) | 链到已删 `canvas-workbench-design.md`；仍写 sticky_note / 分析-only |
| [agent-harness-audit.md](agent-harness-audit.md) | 审计快照；工具路径写 `generate-from-desk.ts` 单体 |
| [agent-tools-optimal-redesign.md](agent-tools-optimal-redesign.md) | 路径与工具表过时 |
| [canvas-toolbar-history-design.md](canvas-toolbar-history-design.md) | sticky_note 切片；与已砍类型冲突 |
| [superpowers/specs/*](superpowers/specs/) | 阶段设计稿；路径 `generate-from-desk.ts` 已迁 `tools/generate/` |
| [superpowers/plans/*](superpowers/plans/) | 已落地计划，非现行 |
| [todo.md](todo.md) | 旧待办；用根目录 `TODOS.md` |
| [ideas/*](ideas/) | idea-refine 草稿；完成态以文内 checklist 为准 |

## 缺失引用（勿再链）

- `docs/canvas-workbench-design.md` — 不存在  
- `docs/implementation/agent-backend-redesign.md` — 不存在  
- `apps/server/src/agent/tools/generate-from-desk.ts` — 已拆到 `tools/generate/`  

## 清理建议（未自动删文件）

1. **短期：** 读文档只走「现行」表；历史 ADR 顶部已标 0012。  
2. **可选归档：** 把 `superpowers/`、`agent-*-review/audit`、旧 `todo.md` 移到 `docs/archive/` 并改链。  
3. **勿删：** `adr/0001–0011` 仍有决策考古价值；删前确认无人引用。  
