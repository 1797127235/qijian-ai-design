# A101 Real Workflow Run 02

## 元信息

- 日期：2026-08-12
- Commit：`28d1ffb`（重跑基线；含断点 #1 修复 `94aa945`、断点 #2 修复 `3d46397`、断点 #5 热修 `28d1ffb`；初次开跑基线为 `3d46397`，首个 run 暴露断点 #5 后作废重跑）
- 文本模型 / 图像模型：文本 `codex2api/grok-4.5-latest`；图像 `grok-imagine-image-quality`（主站 Grok，另有 grok-imagine-image / grok-imagine-image-pro / gpt-image-2@OpenAI2API 可选）
- Project ID / Thread ID：`a96b8ddc-55fd-4110-b0c2-71b8db4c5c59`（项目名"测试2"）/ `22b2feb0-713e-4f90-ae20-60bdb855b26f`（11:02 创建，简报已粘贴）
- LangSmith root IDs：（结束后填）
- 开始 / 结束时间：2026-08-12 10:51 +0800 起（基线指标已存 `metrics-before.prom`，274 行）/ —
- 操作者：liu
- 环境：API 8787 `/ready` OK，Worker 9465 `/ready` OK，vite 5173 OK；API 以 `AGENT_LOG_USAGE=1` 运行（采集逐轮 model_usage/指纹，定位 r01 断点 #2 残余 wake 边界因素）
- 上传素材：`/home/liu/桌面/cf25764c-e458-4a30-9b7b-6ce8ba335917.png`（A101 图纸，同 r01）
- 委托简报：复用 r01 的 `../2026-08-12-a101-r01/client-brief.md`（同场景重跑）
- 重点验证目标：
  1. wake 轮能 `record_project_memory`，不再出现 run failed 与"任务执行失败：任务执行失败"（断点 #1 修复验证）
  2. 全里程碑 9/9（r01 缺 M8 中断恢复、M9 终局汇总）
  3. 固定全量工具集后无 toolEpoch 相关冷读；稳定轮次命中率 ≥90%（断点 #2 修复验证）

## 结果

- Verdict：进行中
- 完成里程碑：0/9
- 稳定轮次缓存命中率：
- Agent runs：completed / failed / stopped / interrupted
- 工具调用：succeeded / failed / interrupted
- 机制性人工介入次数：0

## 时间线

| 时间 | 用户目标 | Agent 行为 | 工具 / JOB | 结果 | 证据 |
|---|---|---|---|---|---|

## 连续性检查

- 已确认事实是否保持：
- 被否方向是否再次出现：
- 中断恢复后是否知道下一步：

## 断点

| # | 时间 | 严重度 | 现象 | 期望 | 首个异常 run / turn / tool | 是否机制问题 |
|---|---|---|---|---|---|---|
| 5 | 11:02:04（首个 run 即复现） | 高 | run 303752d6 判 failed，用户再见"任务执行失败：任务执行失败"。两条独立诱因叠加：① `load_skill("desk-loop")` 实际**成功**，但 `ok()` 不在 details 打标记，`isToolBusinessFailure` 落到内容关键词兜底正则，desk-loop 正文恰好含 1 个"失败/错误/未找到/不能/无法"（design-language 为 0，与一成一败精确对应）→ 成功结果被误判业务失败；② `search_skills` 零命中按设计 `fail()`，探索性无命中也污染 run 终态。另观察到 failed 行 args={}（finish upsert 默认空 args 覆盖 start 行的时序伪影，待查） | 成功结果应有显式 `ok:true` 标记且判定优先采信；零命中搜索是正常探索结果（ok + 空 hits），不该失败；run 终态不被良性结果污染 | run 303752d6 / turn0 / load_skill + search_skills | 是（r01 断点 #1 判定层的姊妹根因） |

断点 #5 已于 11:20 热修并提交（`28d1ffb`）：`ok()` 显式 `ok:true` + 判定采信、search_skills/search_tools 零命中改 ok；回归测试 543 绿 + `build:server` 通过。11:02 的"测试2"项目（thread `22b2feb0`）已被污染作废，r02 以 `28d1ffb` 重开项目重跑，下文时间线从重跑开始。

## 最终桌面与方案叙事

- 三个关键空间：
- 版本与替换关系：
- Agent 两分钟讲述摘要：
- 仍需用户裁决的问题：

## 结论与下一跑

- 本次最先断裂的环节：
- 只修的 Top 1–2：
- 下一次复测范围：
