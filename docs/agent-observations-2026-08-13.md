# Agent 观测问题记录（2026-08-13）

**状态：** 持续跟踪  
**证据源：** LangSmith 项目 `pi`、`.run/server.log`、`.run/worker.log`、本地 Agent 运行数据  
**关联记录：** [Agent 运行错误清单（2026-08-09）](agent-run-errors-2026-08-09.md)、[可观测性手册](runbooks/observability.md)  
**范围：** 2026-08-12 最近一批 Agent 对话及其异步任务

## 状态定义

| 状态 | 含义 |
|------|------|
| `confirmed` | 已由运行数据或日志直接证明 |
| `implemented-unverified` | 代码已实现，尚未用新生产式运行验收 |
| `open` | 已确认问题，尚未实施解决方案 |
| `environment` | 测试或运行环境问题，不归因于 Agent 决策逻辑 |

## O1 · 跨进程 LangSmith 父链损坏

| 字段 | 内容 |
|------|------|
| 现象 | Worker/Server 上报 `dotted_order must contain at least two parts for child runs`；业务任务仍显示成功，但 LangSmith 子 span 丢失或父链断裂 |
| 证据 | `.run/worker.log` 统计 17 次；`.run/server.log` 统计 34 次；错误请求返回 HTTP 400 |
| 根因 | 队列持久化只保存父 run UUID，无法恢复完整 `trace_id` 与 `dotted_order`；一个非法 child 会使 multipart 批次整体失败 |
| 分层 | 观测基础设施 / 跨进程契约 |
| 严重度 | **P1** |
| 状态 | **implemented-unverified** |
| 已处理 | 改为持久化 `TraceContextCarrier`，通过 `RunTree.toHeaders()` / `RunTree.fromHeaders()` 恢复父链；新增迁移 `0027_trace_context_carrier.sql`；未知父节点不再生成 detached child |
| 验收 | 重启 API/Worker 并触发真实异步任务，确认无新的 400、远程 child 与原始 `trace_id` 一致 |

## O2 · 业务成功与追踪失败脱节

| 字段 | 内容 |
|------|------|
| 现象 | Worker 日志记录 24 个 `task_finished`，同时追踪导出失败 51 次；任务结果与观测结果相互矛盾 |
| 证据 | `.run/worker.log` 24 条任务完成记录；同文件 17 条追踪错误；`.run/server.log` 34 条追踪错误 |
| 根因 | O1 的坏 child 令整个批次失败；追踪失败只被异步记录，没有形成“业务成功但观测不完整”的明确状态 |
| 分层 | 观测基础设施 / 运维告警 |
| 严重度 | **P1** |
| 状态 | **implemented-unverified** |
| 后续 | 为 `trace_export_failed` 增加按服务、trace、批次的聚合指标和告警；业务状态不因追踪失败回滚，但必须可见 |

## O3 · 最新模型 span 仍可能停留 pending

| 字段 | 内容 |
|------|------|
| 现象 | LangSmith trace `019ff4e9-a9cd-7000-8000-006a6e6e0796` 中 `model.turn.2` 没有 `end_time`，状态为 `pending` |
| 证据 | `fetch_runs` 返回该 run `end_time=null`、`status=pending`；父 root 仍可继续产生后续工具 span |
| 根因假设 | 修复前的批次失败丢失了 model span 的结束 patch；也需排除进程退出或 flush 时序问题 |
| 分层 | 观测基础设施 / 生命周期 |
| 严重度 | **P1** |
| 状态 | **implemented-unverified** |
| 已处理 | tracer flush 现在同时等待本地队列和 SDK `awaitPendingTraceBatches()` |
| 验收 | 新运行结束后，所有 `model.turn.*` 必须有 `end_time`；进程退出演练不能留下 pending span |

## O4 · 对话上下文持续膨胀

| 字段 | 内容 |
|------|------|
| 现象 | 单轮历史达到 123 条消息；新输入约 2,284 tokens，但 cache read 约 94,976 tokens |
| 证据 | LangSmith `model.turn.2` metadata：`history_message_count=123`；工具 usage observation：`cacheRead=94976`、`input=2284` |
| 根因 | 历史消息、工具结果和状态帧持续累积；缓存命中降低重复计算，但没有降低注意力噪声和总上下文规模 |
| 分层 | 上下文装配 / 模型行为 |
| 严重度 | **P1** |
| 状态 | **open** |
| 候选方向 | 以工作集和摘要替代无界历史；为消息、工具结果、视觉结果设置独立预算；超过阈值触发可观测压缩 |

## O5 · 视觉工具返回体过大

| 字段 | 内容 |
|------|------|
| 现象 | `look_at` 一次返回约 543 KB，图片 Base64 约 542 KB；原始文本约 64k 字符并发生截断 |
| 证据 | LangSmith `tool.look_at`：`result_summary.bytes=543129`、`result_budget.image_base64_chars=542264`、`truncated=true` |
| 根因 | 图片数据同时进入模型输入、运行记录和追踪 payload，工具边界没有把媒体引用与结构化结论分离 |
| 分层 | 工具契约 / 上下文装配 / 观测 |
| 严重度 | **P1** |
| 状态 | **open** |
| 候选方向 | 媒体走受控图像输入或文件引用；文本只保留尺寸、对象、空间关系和不确定性摘要；追踪中不保存 Base64 |

## O6 · 每轮工具面过宽

| 字段 | 内容 |
|------|------|
| 现象 | 最近运行每轮暴露 15 个 active tools，即使当前只是状态查看或记忆记录 |
| 证据 | LangSmith metadata：`active_tool_count=15` |
| 根因 | 工具注册以固定全集为主，意图阶段没有进一步收窄能力面 |
| 分层 | 工具编排 / prompt 设计 |
| 严重度 | **P2** |
| 状态 | **open** |
| 候选方向 | 按感知、记忆、生成、任务管理分组；依据当前阶段启用最小工具集，并记录 tool epoch 变化 |

## O7 · LangSmith 顶层 token/正文不完整

| 字段 | 内容 |
|------|------|
| 现象 | `model.turn.*` 的 LangSmith 顶层 `prompt_tokens`、`completion_tokens`、`total_tokens` 常为 0，inputs/outputs 也为空；实际 usage 只在自定义 outputs 或本地账本中 |
| 证据 | 最近 `fetch_runs`：`model.turn.1` 顶层 token 字段为 0；本地 usage 同时有 input/output/cacheRead |
| 根因 | Provider usage 没有统一映射到 LangSmith 标准字段；正文出于体积/隐私被省略后没有留下足够的摘要 |
| 分层 | 观测契约 |
| 严重度 | **P2** |
| 状态 | **open** |
| 候选方向 | 保留本地事实表作为精确账本；LangSmith 写入截断后的 stop reason、usage、工具计数、摘要 hash，不写原始 Base64 |

## O8 · 进程重启与端口冲突造成运行中断

| 字段 | 内容 |
|------|------|
| 现象 | Worker 在 `tsx` 文件变更后重启；Server 日志出现监听 `8787` 的 `EADDRINUSE` |
| 证据 | `.run/worker.log`：`[tsx] change ... Rerunning...`；`.run/server.log`：`listen ... port 8787` / `EADDRINUSE` |
| 根因 | 开发热重载与已存在进程共用端口；shutdown 时没有把进行中的 Agent run 显式标记为 interrupted |
| 分层 | 运行时 / 开发运维 |
| 严重度 | **P2** |
| 状态 | **environment** + `open` |
| 候选方向 | 启动前做端口/进程协调；shutdown 统一结束或标记当前 run/job；日志明确区分“重启中断”和“模型失败” |

## O9 · 异步任务轮询问题（关联旧记录 E5）

| 字段 | 内容 |
|------|------|
| 现象 | Agent 在任务受理后连续调用 `get_task` 等待完成，拉长单轮对话并增加 token 消耗 |
| 证据 | 详见 [agent-run-errors-2026-08-09.md 的 E5](agent-run-errors-2026-08-09.md#e5--get_task-忙等轮询同步对话拖死) |
| 分层 | 工具契约 / 模型行为 / UX |
| 严重度 | **P2** |
| 状态 | **decided + partially-fixed** |
| 当前方向 | accepted 后结束当前轮；由 Job Wake 事件续跑；只允许用户明确要求时查询任务 |

## 验收清单

- [ ] 执行迁移 `0027_trace_context_carrier`
- [ ] 重启 API 与 Worker，触发至少一条 Agent 生图任务
- [ ] LangSmith 中无新的 `invalid dotted_order`
- [ ] `task.*` 与 `agent.job_wake` 保留源 trace ID，且 dotted order 至少两段
- [ ] 成功 root 下没有 pending 的 `model.turn.*` 或 task span
- [ ] 记录一次上下文消息数、cacheRead、视觉 payload 大小基线
- [ ] 复核端口冲突和 shutdown 中断行为

## 变更记录

| 日期 | 说明 |
|------|------|
| 2026-08-13 | 基于 LangSmith `pi`、Server/Worker 日志和最近运行数据建立记录；O1/O2/O3 标记为代码已修复但待真实运行验收 |
