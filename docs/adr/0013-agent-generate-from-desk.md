# ADR 0013：Agent 可通过 `generate_from_desk` 写桌（效果图）

## 状态

已接受（2026-08-06）  
部分覆盖 [ADR 0012](0012-agent-analysis-only.md) 的「Agent 永不写桌」边界。

## 背景

Phase 0 已让对话看见画布选中。画布面板生图（`CanvasGenerateService` + `effect_image`）已通。  
产品闭环需要：选图 → 对话说改什么 → 新图落回源图旁。

## 决策

1. **允许 Agent 写桌，但仅限一条工具路径**：`generate_from_desk`，实现放在 `apps/server/src/agent/tools/`。  
2. **复用** `CanvasGenerateService.generate`（落点、连线、参考图收集与面板生图一致）。  
3. **来源标记**：payload `source: "agent_chat"`；`createdBy: "agent"`。  
4. **源物件解析**：工具参数 `source_artifact_id` 优先；缺省用本轮 prompt 的 `selectedArtifactIds[0]`；皆无则工具失败。  
5. **完成判定**：以工具返回与 `object_changed` 为准；禁止无工具结果时声称已落桌。  
6. **非本 ADR**：list/get 工具、便签写工具、独立 selection 同步、multi-agent。

## 后果

- 正向：对话与面板共用生图管线；前端已有 `object_changed` 刷新。  
- 负向：Agent 可产生桌面副作用；需靠工具描述 + system prompt + 测试约束幻觉。  
- 0012 中「分析-only」改为「默认分析；经注册工具可写 effect_image」。
