# ADR 0012：Agent 范围限定为「分析 + 附件 + 对话」，不写桌面

## 状态

**已由 [ADR 0013](0013-agent-generate-from-desk.md) 部分覆盖**（2026-08-06 起 Agent 可经工具写 `effect_image`）。  

本文保留为历史决策：曾将 Agent 收成「分析 + 附件 + 对话」、并缩窄 Artifact 类型。**勿再按本文「永不写桌 / 无 effect_image」实现。**

## 背景

此前产品方向希望 Agent 成为设计桌面的行动者，通过工具落便签、方向集、效果图等。实现路径上，Agent 工具集先后删除两次（`refactor: remove legacy agent tools`、`0c954aa`），注册入口 `createDeskTools()` 当前返回 `[]`。在没有工具的窗口期里，`understanding_note` / `design_directions` / `effect_image` 三种 Artifact 类型只在前端渲染层与后端 payload 规则中有占位，没有任何创建路径。

继续保留这三种类型和相关 schema 的成本：

- `domain/types.ts` 的 `artifactTypes` 联合、payload 规则、测试 fixture 都得跟着维护；
- 前端 `DeskObject` / `map.ts` / `nodes.tsx` 要为不会到达的 type 留分支；
- `desk-state-service` 还要为永远不会命中的 `effect_image` 做封面聚合；
- `README.md` / `CONTEXT.md` / ADR 都要解释「保留供 Agent 用」的占位语义。

## 决策

1. **Agent 当前作用域 = 分析 + 附件 + 对话**：读取聊天历史与上传文件，给出文字回复。不调用任何写桌面的工具。
2. **Artifact 类型缩窄为 `sticky_note` / `canvas_image`**：两种类型都对应设计师的画布直接创作路径。`understanding_note` / `design_directions` / `effect_image` / `space_map` / `proposal_package` 从 schema 中删除。
3. **不保留"工具集暂时为空"的语义**：架构上 `createDeskTools()` / `ToolDependencies` 的注册入口与写路径依赖当前保留（零成本），但不再描述为"未来恢复的入口"。如未来切片决定引入 Agent 写桌能力，应另开 ADR 并补回相应类型。
4. **ProjectSummary 不再有 `effectCount` / `coverUrl`**：来源聚合点（`desk-state-service.listProjects`）已无 `effect_image` 可聚合，删字段比保留空值更诚实。

## 非决策

- 不在本 ADR 重申 Agent 何时或是否会成为桌面行动者（留给未来 ADR）。
- 不在领域词表 `CONTEXT.md` 中删除「理解便签 / 方向集 / 效果图变体」等概念——这些仍是产品叙事的合法目标，本 ADR 只声明当前实现路径不产生它们。
- 不触碰聊天、附件、文件存储、提案导出等非桌面写路径。

## 后果

- 正向：schema 与渲染层单一职责；`map.ts` / `nodes.tsx` 切换 exhaustive；payload 规则只剩两种类型的最小校验；`ProjectSummary` 不再假装有封面/计数。
- 正向：`README.md` / `CONTEXT.md` / ADR 之间不再有"占位 / 未来 / 暂空"这类含糊措辞。
- 负向：若未来要恢复 Agent 写桌能力，需要重新设计 `understanding_note` / `design_directions` / `effect_image` 的 payload 规则与 UI；这是一次性成本，不再为"占位"持续付息。
