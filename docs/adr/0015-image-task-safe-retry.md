# ADR 0015：生图任务安全有界重试（无查单、无网关幂等）

## 状态

已接受（2026-08-10）；P0 实现中。  
规格细节：[ideas/image-task-safe-retry.md](../ideas/image-task-safe-retry.md)。

## 背景

ADR 0014 将生图迁到 BullMQ + PostgreSQL operation 幂等边界，但执行失败时 Worker 仍常直接 `finalize(failed)`。  
产品需要瞬时故障自愈，同时禁止在「可能已向上游开画」时盲目第二次 `generate`。

2026-08-10 对现行网关实测：

- 同步 OpenAI 兼容 `/images/generations`，成功体无稳定业务 job id；
- 常见异步查询路径 404；
- `Idempotency-Key` 同键两次得到不同图像与不同 `x-request-id`。

因此不能把「先查单」或「幂等键重提」当作当前默认能力。

## 决策

1. **错误分类**（沿用并接线 `classifyTaskError`）  
   - `RATE_LIMITED` / `PROVIDER_5XX` / `NETWORK` 且能判定**请求未发出** → 自动重试；  
   - `VALIDATION` / `PROVIDER_AUTH` → 立即失败；  
   - `PROVIDER_TIMEOUT` / `NETWORK` 受理不明 / operation 中间态不明 → `needs_review`，禁止自动再 generate。

2. **有界自动重试**  
   - 默认最多 3 次（含首次），指数退避（默认 2s 起，封顶 60s）；  
   - 在**同一业务 task 仍为 `running`** 时，将 `generation_operations` 从可安全的 `provider_pending` **rearm** 回 `prepared`，再 `beginProvider`；  
   - 预算耗尽或不可重试 → `failed` 或 `needs_review`；  
   - **不**把 BullMQ `attempts` 调高来重放整段 handler。

3. **与队列边界**  
   - BullMQ 仅调度；业务 attempt 以 `generation_operations.attempt` 为准；  
   - 项目级 `TASK_PROJECT_IMAGE_CONCURRENCY` 在重试期间仍占用；  
   - 命名任务保持软失败。

4. **搁置**  
   - 上游查单、网关幂等键、终态任务自动 reopen API（待能力或 P1）。

## 后果

**正向：** 限流/短 5xx/连不上可自愈；超时不双花；与 0014 operation 模型一致。  
**代价：** 部分「其实已拒」的 5xx 若误判为不明会进人工；持锁重试会短时占用并发槽。  
**后续：** 网关具备幂等或异步 job 时，另开 ADR 扩展，不推翻本分类表。

## 关联

- [ADR 0014](0014-bullmq-task-queue-for-asset-batches.md)  
- [runbooks/asset-task-queue.md](../runbooks/asset-task-queue.md)  
- 代码：`apps/server/src/tasks/state-machine.ts`、`handlers/image-generate.ts`、`generation-operation-store.ts`、`bullmq/worker.ts`
