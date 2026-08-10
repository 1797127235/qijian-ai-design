# 生图任务安全重试（回退规格）

> 2026-08-10。实测上游后回退：不做网关幂等键、不做上游查单。  
> 决策见 [ADR 0015](../adr/0015-image-task-safe-retry.md)。  
> **状态：** 规格已定；P0 实现中。

## Problem

批量/单张生图会遇到限流、上游 5xx、网络抖动。当前 Worker 几乎一律 `failed`，没有有界自动恢复；同时又不能在「可能已经开画」时盲目再调 `generate`（双花、双图）。

## 上游事实（2026-08-10 实测）

| 上游 | 协议 | 任务 id | Idempotency-Key |
|------|------|---------|-----------------|
| codex2api（Grok） | 同步 `POST /v1/images/generations` | 响应无 job id | 同 key 两次 → 两张不同图 |
| openai2api（gpt-image-2） | 同上 | 无 | 同上无效 |

异步路径（`/v1/tasks|jobs|predictions/...`）均为 404。  
**结论：** 方案「超时先查单」与「同幂等键安全重试」当前都不可用。

## Non-goals（明确不做）

- 依赖上游 `job_id` 轮询/webhook（方案 2）
- 依赖 `Idempotency-Key` 去重（方案 1，网关未认）
- 用 BullMQ `attempts>1` 盲重放 `generate`
- 超时后自动再调生图
- 把命名任务硬失败拖垮图像成功

## 错误三类（产品语言）

1. **会自动再试（白跑了）**  
   限流明确拒绝、对方 5xx 明确拒绝、网络在**发出请求前**失败（连不上等）。
2. **不试直接失败**  
   参数错、模型未知、密钥/权限错。
3. **卡住（情况不明）**  
   超时且不知是否已开画、网络断在请求过程中、operation 锁丢/仍 `provider_pending`、reconciler 发现 running 无 Redis job。

## 策略

| 项 | 规则 |
|----|------|
| 自动再试次数 | 含首次共 **3** 次（`TASK_IMAGE_MAX_ATTEMPTS`，默认 3） |
| 退避 | 越等越久：`TASK_IMAGE_BACKOFF_MS` 默认 2000 → 2s、4s、8s，封顶 60s |
| 执行位置 | **同一次 Worker 领跑内**、任务保持 `running`、operation 在可安全状态重入 `prepared` 再 `beginProvider` |
| 终态前 | 未耗尽预算前**不得** `finalize(failed)` |
| 超时/不明 | `needs_review`，禁止自动 `generate` |
| 显式重试 | 人/Agent 可触发（产品视为可能再计费）；P0 可先沿用「用户重新发起生成」；专用 reopen API 为 P1 |
| 提示 | 轻提示「正在重试 2/3」（P1 事件通道）；P0 至少写 task error/attempt 审计 |
| 并发 | 重试仍占同项目图像 active 配额 |
| 命名 | 软失败不变 |

## 与 BullMQ

- BullMQ 继续只做**我们自己的**排队/调度。
- Job `attempts` 保持 **1**；业务 attempt 在 `generation_operations.attempt`（`beginProvider` 递增）。
- 配额满仍用 `moveToDelayed` + `DelayedError`（与失败重试无关）。

## 验收（P0）

1. 模拟限流/5xx：同一 task 最多 `generate` 3 次，前两次 rearm 后成功则任务 `succeeded`。  
2. 模拟 `AmbiguousProviderResultError` / 超时不明：`generate` 仅 1 次，任务 `needs_review`。  
3. 参数/未知 model：1 次失败，不重试。  
4. 命名失败不改变图像 `succeeded`。  
5. 重试过程中项目图像并发配额仍生效。

## 后续（有上游能力再开）

- 网关认幂等键 → 超时后同 key 重提可升为安全路径。  
- 上游异步 job API → Step + Delayed 轮询（官方 BullMQ process-step 模式）。  
- 显式 reopen 状态机 + 批次计数回滚规则。
