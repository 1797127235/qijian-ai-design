# Agent Phase 1：`generate_from_desk` 设计

**状态：** 已定稿  
**日期：** 2026-08-06  
**ADR：** [0013](../../adr/0013-agent-generate-from-desk.md)  
**范围：** 仅一个写桌工具；文件在 `apps/server/src/agent/tools/`。

## 目标

选中（或指定）源物件 → 对话描述修改 → Agent 调用 `generate_from_desk` → `effect_image` 落源右侧并连线 → WS `object_changed` 刷新画布。

## 工具

| 字段 | 说明 |
|------|------|
| name | `generate_from_desk` |
| prompt | 必填，生成意图 |
| source_artifact_id | 可选 UUID；默认本轮选中 |

执行：`CanvasGenerateService.generate`；`clientOpId = agent:{toolCallId}`；emit `object_changed`。

## 接线

- `ToolDependencies.generate`  
- `createDeskTools` 返回该工具  
- SessionRegistry 把本轮 `selectedArtifactIds` 注入工具上下文  
- system prompt 声明可调用写桌工具  

## 非目标

list/get、便签、改面板 UI、multi-agent。
