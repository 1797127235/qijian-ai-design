# Dogfood Day 0：A101 整屋同桌

> idea-refine 确认方向 **G**（2026-08-09）。意图见 [human-agent-desk-loop](../intent/human-agent-desk-loop.md)。

## Problem Statement

How might we, in the next days, discover the real gaps in human–agent same-desk collaboration by hard-running a whole-home story from one elevation+floorplan sheet—before committing a 3–4 week feature roadmap?

## Recommended Direction

**G：证据驱动 dogfood。** Day 0 零开发硬跑；只记机制断点；之后按 Top 断点最小修复，再跑。不预建工具墙、不预建提案编辑器、不并行清工程债主线。

产品终局仍服从人机同桌意图：对等同桌 → 可讲一盘 → 远期汇报包。G 只决定**近程怎么选刀**。

第一盘源图：`A101` 现代住宅立面 + 一/二层平面（用户本地参考图）。

## Key Assumptions to Validate

- [ ] Agent 能从 A101 读出空间并生成可用室内效果（Day 0 实测）
- [ ] 人改一句后 Agent 能接着改同一空间/邻接空间（Day 0 接力段）
- [ ] 断点可聚成 ≤5 类且能排出 P0（Day 0 复盘 30min）

## MVP Scope（Day 0 剧本）

**In**

1. 新建项目，上传 A101，放桌
2. 对话：理解图纸 → 约定风格/生活方式（作者当客户口述）
3. 至少 3 个关键空间各出 ≥1 张效果（默认：客厅、主卧、厨房；可含外立面氛围一张）
4. 人至少改一轮（面板 / 对话 / 局部重绘均可）→ Agent 再接力一轮
5. 结束时口述 2 分钟「我会怎么跟客户讲」
6. 写下断点表：现象 / 期望 / 严重度 / 是否机制问题 → [a101-day0](../dogfood/a101-day0.md)

**Out（Day 0）**

写代码、新工具、提案包 UI、全屋一次出齐、工程债 TODO。

**Day 1+ 规则**

只修断点表 Top 1–2；修完再短跑同一剧本；循环直到「能串完一盘」。

## Not Doing (and Why)

- 预排 4 周功能路线图 — 无证据会排错
- 建筑学长式工具入口 — 与内聚意图冲突
- 完整提案包/导出 — 远程，闭环后再做
- 以审美完美为失败标准 — 非设计师噪声
- 并行大改 harness「最优架构」— 除非断点证明必须

## Open Questions

- Day 0 定哪天、预留多久（建议 2–3h 整块）？
- 3 关键空间是否就定为 客厅 / 主卧 / 厨房？（默认是，可在 day0 日志里改）
