# Agent 过程面板（思考 + 工具）设计

**状态：** APPROVED  
**日期：** 2026-08-06  
**方案：** C（工具过程 + 可选 thinking 流）  
**相关：** [agent-harness-audit](../../agent-harness-audit.md) H7

## 目标

工作时可见可折叠过程：思考（若有）+ 工具执行；结束后保留在本轮旁；失败可展开看原因。

## 交互

- 默认折叠条：`思考中` / `执行工具：xxx` / `已完成 · 思考 + N 工具` / `失败 · 工具名`
- 点击展开：思考文本（截断）+ 工具列表（名、参数摘要、结果/错误）
- 无 thinking 时隐藏「思考」段，只显示工具

## 数据

| 内容 | 事件 |
|------|------|
| 思考 | `message_update` + `thinking_start/delta/end` |
| 正文 | `message_update` + `text_delta`（仍进主回复） |
| 工具 | `tool_execution_start/end` |

## 范围

- 第一刀：live 会话内保留过程卡；不强制 DB 历史回放
- 不做：默认展开整篇 CoT、trace 后台

## 实现要点

- `ChatItem` 增加 `process` 角色
- `useChatSession` 收集 steps，settled 后保留
- `ChatMessageList` 渲染可折叠过程卡
