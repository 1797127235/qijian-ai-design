---
name: design-language
description: 家装前期视觉语言用法——如何把风格配方用进方向卡与生图，而不把风格当成完整设计方向。用户谈风格、氛围、材料语言、方向比较时使用。具体条目见 data/design-library/styles.json。
summary: 把风格配方用进方向卡与生图，不把风格当成完整设计方向
---

# 视觉语言（设计库用法）

## 边界

- **视觉语言**是设计方向的一部分（概念 / 空间策略 / 视觉语言 / 生活方式）。
- 不要只回复一个风格中文名；要展开材料、光、开口与反模式。
- 条目真源：`data/design-library/styles.json`（及 styles.md）。本 skill 不复制全表。

## 工作步骤

1. 用户提到风格或氛围 → 按 styles.json 的 id/中文名/别名定位条目，展开 `visual_language` 与 `prompt_hooks`。
2. 写方向卡时组合：自拟概念 + 条目的 `space_strategy` + `visual_language` + `lifestyle`。
3. 生图：合并项目事实与选中图 + `prompt_hooks` + 材料三件套；检查 `anti_patterns`。
4. 需要落桌生图：`search_tools` 激活生图工具；本 skill **不**授予任何工具。
5. 用户确认采用某方向后，才可 `record_project_memory`（design_decision / visual_system）。

## 反模式

- 把「极简」说成已定方案却无材料与光
- 未查库就编造 prompt_hooks
- 加载本 skill 后声称已能 generate（须 search_tools）
- 把欧式/巴洛克直接做成满屋线脚（库内优先 beaux-axis 克制 L2）
