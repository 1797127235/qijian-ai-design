# ADR 0013：Agent 可通过 `generate_from_desk` 写桌（效果图）

## 状态

已接受（2026-08-06）  
部分覆盖 [ADR 0012](0012-agent-analysis-only.md) 的「Agent 永不写桌」边界。

## 背景

Phase 0 已让对话看见画布选中。画布面板生图（`CanvasGenerateService` + `effect_image`）已通。  
产品闭环需要：选图 → 对话说改什么 → 新图落回源图旁。

## 决策

1. **允许 Agent 写桌，写桌生图共用一条管线**（`CanvasGenerateService` + 异步 Job），实现在 `apps/server/src/agent/tools/generate/`。  
2. **Agent 工具名可多个，语义按落点拆分**（2026-08-10 修订）：  
   - `generate_from_desk` — 主源旁落新 effect_image  
   - `replace_on_desk` — 原卡 append 替换画面  
   - `text_to_image_on_desk` — 无主源文生图落桌（spawn；空位算法，可选参考）  
   - `remove_from_desk` — 硬删桌面物件（与 HTTP DELETE 同路径；用户明确要求时）  
3. **Job kind** MVP 仍统一为 `generate_from_desk`，靠 input `placement` / `tool` 区分；观测不够时再分 kind。  
4. **并发**：同项目 Agent 写桌生图 active 默认上限 2（`AGENT_DESK_GENERATE_MAX_ACTIVE`）；create 路径串行化防竞态。旁落 complete 的 lockKey 为**新卡 id**（非主源），避免同主源多旁落互 abort。  
5. **来源标记**：payload `source: "agent_chat"`；`createdBy: "agent"`。  
6. **源物件解析**：工具参数 `source_artifact_id` 优先；缺省用本轮单选；多选无显式 id 则失败。  
7. **完成判定**：以工具返回与 `object_changed` / `[JOB_EVENT]`（可短窗批合并）为准；禁止无工具结果时声称已落桌/已删除。  
8. **非本 ADR**：list/get 工具、便签写工具、独立 selection 同步、multi-agent、Agent 局部重绘、素材库。

## 后果

- 正向：对话与面板共用生图管线；旁落/替换语义对 Agent 更清晰；代码按工具包可扩展。  
- 负向：Agent 可产生桌面副作用；多工具名需 system prompt 防选错。  
- 0012 中「分析-only」改为「默认分析；经注册工具可写 effect_image」。
