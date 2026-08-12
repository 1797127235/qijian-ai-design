# Agent Prompt Cache Benchmark

该基准通过产品真实 HTTP + WebSocket 路径调用 Agent，使用 Pi `message_end.usage` 中 Provider 返回的 `input / cacheRead / cacheWrite`，同时验证工具调用和异步任务能力。

## 运行

服务端、Worker、PostgreSQL 与 Redis 需先启动，模型配置从 `.env` 和 Pi models 配置读取。

```bash
# 完整集合：包含一次真实生图
npm run benchmark:cache

# 重复三次，用于测量 Provider 路由方差
npm run benchmark:cache -- --repeat=3

# 单场景
npm run benchmark:cache -- --scenario=large_desk_resync

# 排除生图
npm run benchmark:cache -- --skip-image
```

常用参数：

| 参数 | 说明 |
|---|---|
| `--base-url=http://127.0.0.1:8787` | 被测服务地址 |
| `--scenario=a,b` | 只运行指定场景 |
| `--repeat=1..10` | 重复整个场景集合 |
| `--skip-image` | 跳过真实生图场景 |
| `--output=path` | JSON 与 Markdown 报告目录 |
| `--keep-projects` | 保留隔离测试项目供人工检查 |

默认情况下，每个场景创建独立项目与 thread，结束后删除。报告不保存模型正文、密钥或图像数据，只保存 token usage、场景结果与工具名。

## 场景集合

| 场景 | 验证内容 |
|---|---|
| `steady_dialogue` | Stable System、固定 Kernel、append-only history |
| `skill_emit_once` | `$design-language` 首次正文注入与后续 emit-once |
| `tool_working_set` | `search_tools`、memory 工具和持久化 schema 工作集 |
| `large_desk_resync` | 140 对象 Desk full 硬预算与后续 unchanged |
| `desk_delta` | 单对象移动 delta 与后续恢复 |
| `image_generation_and_wake` | 工具发现、真实文生图、异步 JOB wake 和生成后稳定轮 |

每个场景包含 1 个 cold 轮、4 个 warmup 轮和至少 9 个 eligible 稳定轮。工具、Skill 与 wake 产生的内部模型调用会单独计量。Desk delta 的变化轮以及图像/wake 轮不进入 eligible cohort，但仍进入全流量统计。

## 统计口径

```text
read_hit_rate = ΣcacheRead / (Σinput + ΣcacheRead)
effective_reuse_rate = ΣcacheRead / (Σinput + ΣcacheRead + ΣcacheWrite)
```

聚合先对 token 求和再相除。报告同时给出：

- eligible token 加权命中率，目标 92%；
- eligible 单轮命中率达到 90% 的比例，目标 90%；
- severe miss（单轮命中率低于 10%）比例；
- 全流量 effective reuse，作为短时观测项。生产 90% SLO 仍使用 7 日真实流量。

## 2026-08-12 实测基线

模型：`codex2api/grok-4.5-latest`；生图：当前 `.env` 默认模型。

最终规范集合共 95 次内部模型调用，六个功能场景全部通过。54 个 eligible 轮次中 53 个达到 90% 以上，达标率 98.15%；token 加权命中率为 93.00%，通过 92% 缓冲目标。包含 cold、warmup、工具跟进和 wake 的短时全流量复用率为 84.08%；它是隔离基准观测值，不替代 7 日生产 SLO。

稳定表现：

- 纯对话 eligible：92.81%，9/9 达到 90%；
- Skill emit-once eligible：94.23%，9/9 达到 90%；
- 工具工作集 eligible：93.54%，9/9 达到 90%；
- Desk delta eligible：94.45%，9/9 达到 90%；
- 生图 + wake 后 eligible：95.52%，9/9 达到 90%。

大桌场景有 8 个 eligible 轮次位于 95.6%–97.1%，另有一个 19.79% 的路由 miss，使该场景 token 加权值降为 88.96%。前一次完整重复测量则得到 89.66% 总 eligible 加权率，并出现 3 个 `<10%` severe miss。异常在不同场景和轮次随机出现，下一轮通常立即恢复，当前证据指向 Provider cache affinity / 路由一致性。单次规范集合已达标，但跨次方差仍不满足“稳定保证”，生产结论必须继续使用重复测量与 7 日观测。

原始报告：

- [最终规范测量](../results/final/agent-cache-2026-08-11T18-53-24-431Z.md)
- [前一次完整重复测量](../results/full-repeat/agent-cache-2026-08-11T18-38-15-648Z.md)
- [生图单场景验证](../results/image/agent-cache-2026-08-11T18-36-08-890Z.md)
