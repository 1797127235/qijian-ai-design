# Agent 真实流程基准

这个目录用于运行端到端、长时间、包含真实模型与真实工具副作用的 Agent 工作流。它验证的不是某个函数是否正确，而是一整条协作弧线能否持续完成：理解资料、形成方向、分步产出、主动验收、接受纠正、跨轮保持连续性，并在结束后留下可复查的运行证据。

现有 [`../agent-cache/README.md`](../agent-cache/README.md) 负责隔离测量 Prompt Cache；本目录负责产品能力。真实流程仍会记录缓存数据，但不会为了提高命中率而简化任务。

## 当前首要场景：A101 整案协同

场景来源：

- [`../../docs/intent/agent-whole-project-codesign.md`](../../docs/intent/agent-whole-project-codesign.md)：整案长弧线的目标和成功定义；
- [`../../docs/dogfood/a101-day0.md`](../../docs/dogfood/a101-day0.md)：第一次真实运行的断点和历史证据；
- [`../../docs/ideas/dogfood-day0-a101.md`](../../docs/ideas/dogfood-day0-a101.md)：A101 原始剧本。

这次重跑使用同一类户型/参考资料，至少完成以下里程碑：

1. 新建隔离项目，上传户型图和参考图，并放入桌面。
2. Agent 读取资料，说明它理解的空间、约束和仍需用户裁决的设计问题。
3. 用户确认风格、生活方式和首批空间；确认过的事实之后不再重复询问。
4. 客厅、主卧、厨房至少各生成一版，任务按可控节奏执行。
5. 每个产出完成后由 Agent 使用 `look_at` 或 `look_at_desk` 验收，再决定接受、修正或向用户说明能力边界。
6. 用户否定或纠正至少一个设计方向，Agent 在后续轮次继续遵守该裁决。
7. 至少经历一次异步 JOB wake；同批任务以可理解的汇总方式回到主叙事。
8. 中断一段时间后继续同一 thread，验证上下文帧、项目记忆和桌面状态能恢复工作。
9. 结束时由 Agent 汇总已完成内容、未解决风险和下一步，并给出可向客户讲述的两分钟方案叙事。

## 真实的含义

一次有效运行必须同时满足：

- 通过产品 HTTP、WebSocket、Worker 和数据库路径运行；
- 使用当前配置的文本模型与图像模型；
- 工具实际读写桌面，异步任务实际进入 BullMQ；
- 操作者通过真实 UI 与 Agent 协作，不直接修改数据库制造成功状态；
- 保留失败、超时、重试和人工纠正，它们都是基准结果的一部分；
- 流程开始后不改代码。发现的问题进入本次运行报告，修复后另开一次 run 重测。

## 运行前准备

记录当前 commit，确保数据库已迁移，然后启动完整运行环境：

```bash
git rev-parse HEAD
docker compose up -d postgres redis
npm run db:migrate
npm run dev:server
npm run dev:worker
```

检查两个进程都可接流量：

```bash
curl -fsS http://127.0.0.1:8787/ready
curl -fsS http://127.0.0.1:9465/ready
```

如本机已有监测镜像，再启动聚合看板：

```bash
docker compose --profile monitoring up -d
```

Grafana/Prometheus 没有启动时，Agent、PostgreSQL 事实表和 LangSmith 仍会记录真实运行数据；这不阻塞流程，但运行报告要注明缺少哪一层证据。

## 每次运行的目录

开始前在本目录创建一个运行目录：

```text
runs/YYYY-MM-DD-a101-rNN/
├── run.md                 # 人工运行记录和最终结论
├── telemetry.json         # 结束后从 chat history API 导出的轮次数据
├── metrics-before.prom    # 运行前 API 指标快照
├── metrics-after.prom     # 运行后 API 指标快照
└── evidence/              # 必要的桌面截图或人工验收证据
```

原始上传资料、模型生成的大图、密钥和完整服务日志不放入 Git。需要长期保留时，将它们存入受控对象存储，并在 `run.md` 中写证据引用。`telemetry.json` 在提交前也要确认不包含不应公开的用户原文。

建议先保存基线指标：

```bash
mkdir -p benchmarks/real-agent-workflows/runs/YYYY-MM-DD-a101-rNN/evidence
curl -fsS http://127.0.0.1:8787/metrics \
  -o benchmarks/real-agent-workflows/runs/YYYY-MM-DD-a101-rNN/metrics-before.prom
```

## 操作原则

操作者只负责真实用户会做的事情：提供资料、表达偏好、做设计裁决和指出明显错误。以下行为计为“机制性人工介入”，必须记录：

- 再次解释已经确认的事实；
- 告诉 Agent 该调用哪个工具；
- 手工整理 Agent 弄乱的桌面；
- 催促它继续本来应该继续的任务链；
- 清理重复 wake、重复资产或失控任务；
- 通过重启服务、改数据库或改代码让流程继续。

设计偏好、审美裁决和是否接受方案属于正常协作，不计为机制性介入。

## 证据采集

### 单次运行

LangSmith 是单次 run 的完整父子链：

```text
Agent root
└── model.turn.N
    ├── tool span
    └── 后续 model.turn.N+1
        └── BullMQ worker child / JOB wake
```

每个工具应能关联到发起它的模型轮次，并看到参数摘要、结果大小、耗时、执行状态以及工具结果进入上下文后的 prompt token 变化。

### 本地事实表

- `chat_runs`：每条用户消息触发的 Agent run、状态、耗时和 LangSmith root ID；
- `chat_model_turns`：每次 Provider 请求的 input、output、cache read、cache write 和总 token；
- `chat_tool_calls`：工具轮次、参数/结果大小、状态、前后 prompt token 和并行批大小；
- `agent_jobs` 与任务表：异步任务、Worker 与 JOB wake 的关联链。

这套观测不记录金额。

### 对话历史导出

从浏览器网络面板或 API 取得 `projectId`、`threadId` 后导出：

```bash
curl -fsS \
  "http://127.0.0.1:8787/api/projects/PROJECT_ID/chat/messages?threadId=THREAD_ID" \
  -o benchmarks/real-agent-workflows/runs/YYYY-MM-DD-a101-rNN/telemetry.json

curl -fsS http://127.0.0.1:8787/metrics \
  -o benchmarks/real-agent-workflows/runs/YYYY-MM-DD-a101-rNN/metrics-after.prom
```

History API 返回消息、最近 100 次工具调用和最近 200 个模型轮次。超过这个规模的长流程，以 PostgreSQL 和 LangSmith 为完整证据源，不把被截断的 API 导出当作全量统计。

## 缓存口径

单轮缓存读命中率：

```text
cache_hit_rate = cacheRead / (input + cacheRead)
```

对稳定轮次先求 token 总和再计算：

```text
stable_cache_hit_rate = ΣcacheRead / (Σinput + ΣcacheRead)
```

运行报告同时记录 cold start、工具跟进、JOB wake、压缩边界和稳定对话，不能只挑高命中轮次。稳定轮次 token 加权命中率目标为至少 90%；冷启动与大状态变化作为单独 cohort 解释。

## 验收门槛

### 必须满足

- 九个 A101 里程碑全部有结果，失败也有明确终态和证据；
- 所有 Agent run 都收敛到 `completed`、`failed`、`stopped` 或 `interrupted`，没有遗留 `running`；
- 每个模型轮次和工具调用都能关联到具体 `runId`，观测覆盖率为 100%；
- 三个关键空间均有产出，每个被 Agent 验收至少一次；
- 用户确认的事实在后续保持一致，被否方向不再次主动提出；
- 异步任务没有无界并发，同批 wake 不打断主叙事；
- 稳定轮次 Prompt Cache token 加权命中率不低于 90%；
- 运行结束时队列无本次测试遗留任务，桌面上的版本关系可解释。

### 直接判为流程失败

- Agent 把未完成任务描述为已经完成；
- 工具或 Worker 发生副作用，但追踪链无法定位到对应 run；
- 连续失败后无限重复同一生成策略；
- 已确认事实丢失导致方案方向或空间对象错位；
- 必须修改代码或数据库才能完成本次流程。

审美不够理想本身不判流程失败；它应记录为设计质量问题，并由用户决定接受、纠正或换方向。

## `run.md` 模板

```markdown
# A101 Real Workflow Run NN

## 元信息

- 日期：
- Commit：
- 文本模型 / 图像模型：
- Project ID / Thread ID：
- LangSmith root IDs：
- 开始 / 结束时间：
- 操作者：

## 结果

- Verdict：PASS / FAIL / INVALID
- 完成里程碑：0/9
- 稳定轮次缓存命中率：
- Agent runs：completed / failed / stopped / interrupted
- 工具调用：succeeded / failed / interrupted
- 机制性人工介入次数：

## 时间线

| 时间 | 用户目标 | Agent 行为 | 工具 / JOB | 结果 | 证据 |
|---|---|---|---|---|---|

## 连续性检查

- 已确认事实是否保持：
- 被否方向是否再次出现：
- 中断恢复后是否知道下一步：

## 断点

| 严重度 | 现象 | 期望 | 首个异常 run / turn / tool | 是否机制问题 |
|---|---|---|---|---|

## 最终桌面与方案叙事

- 三个关键空间：
- 版本与替换关系：
- Agent 两分钟讲述摘要：
- 仍需用户裁决的问题：

## 结论与下一跑

- 本次最先断裂的环节：
- 只修的 Top 1–2：
- 下一次复测范围：
```

## 迭代规则

第一次重跑建立基线，不在运行途中修复。结束后只选择断点表中最高优先级的 1–2 个机制问题；修复、测试、提交后，用新的 `rNN` 目录重跑同一场景。只有同一场景连续通过后，才增加更多空间、更长暂停或更多并行任务，避免同时改变任务难度与系统实现。
