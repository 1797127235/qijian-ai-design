# ADR 0014：使用 BullMQ 统一调度资产任务批次

## 状态

已接受并完成；BullMQ 是唯一运行时后端（2026-08-10）

## 背景

自动取名和批量生成资产本质上都是一批可追踪、可重试、可取消的后台任务。迁移前使用进程内 `AgentJobRunner`（`prepare`/`work` 闭包、内存 `AbortController`、项目级并发锁），有结构性问题：

- 进程重启丢失排队/执行上下文；
- 超并发直接失败，不能可靠排队批量请求；
- 闭包不可序列化，无法独立 Worker / 多进程；
- 命名、单张生图、批量缺少统一进度/重试/取消；
- 业务审计仍须落在 PostgreSQL（`agent_jobs`），不能只靠队列内部状态。

Redis 已接受为基础设施，因此选用成熟 Redis 队列做持久调度；业务事实仍在 PostgreSQL。

## 决策

### 1. BullMQ 作为队列后端

引入 `bullmq` 和 `ioredis`，使用 BullMQ 的 `Queue`、`Worker` 和 `FlowProducer`：

- `FlowProducer` 负责创建批次的父子 Job 和依赖关系；
- `Worker` 负责并发、重试、退避和故障恢复；
- Redis 只保存调度所需的队列状态，不作为业务事实或 UI 查询源；
- PostgreSQL 继续保存 `agent_jobs`、批次、资产状态、错误和审计信息。

### 2. 统一任务批次模型

新增 `task_batches`（批次）及其任务明细（可单独建表或通过 `agent_jobs.batch_id` 关联）。批次至少包含：

- `id`、`project_id`、创建者和创建时间；
- `status`：`accepted`、`running`、`succeeded`、`partial_failed`、`failed`、`cancelled`；
- `total`、`completed`、`failed`、`cancelled` 计数；
- 原始请求快照和可供 UI 展示的错误摘要。

每个资产是一个可独立重试的任务：

```text
task_batch
  ├─ image_task
  │    └─ optional name_task
  ├─ image_task
  │    └─ optional name_task
  └─ image_task
```

图像任务成功后再调度对应的命名任务。批次 `total` 只统计用户请求的资产图像任务；命名任务是内部软任务，不增加用户进度分母。每个子任务有唯一完成记录/版本号，批次计数通过数据库条件更新去重。图像任务成功而命名最终失败时，批次仍可 `succeeded`，但在错误摘要中显示命名失败；图像失败则批次为 `partial_failed` 或 `failed`，取消优先级和父子终态规则由状态机实现。

### 3. PostgreSQL 与 BullMQ 的职责边界

`agent_jobs` 增加 `queue_backend`、`queue_job_id`、`enqueued_at`、`batch_id`、`task_role` 等字段，并新增事务性 `task_queue_outbox`。入队采用 outbox，而不是 PostgreSQL 与 Redis 的不可靠双写：

1. 一个 PostgreSQL 事务创建业务任务、必要的 pending artifact 和唯一 outbox 记录；
2. Dispatcher 以 `outbox.id`/业务 `jobId` 作为稳定 BullMQ `jobId`，重复 `add` 必须得到同一逻辑 Job；
3. Dispatcher 成功确认 Redis 后，将 outbox 标记 `enqueued` 并回写 `queue_job_id`；超时或进程崩溃由可重复运行的 reconciler 查询并重试；
4. Worker 以 `jobId` 幂等地更新任务终态和世界状态，消费前先检查 PostgreSQL 任务状态与项目是否仍存在。

BullMQ 的 Job ID 必须与业务任务 ID 建立稳定映射。重复投递、Worker 重启或网络重试不得重复创建资产版本、重复扣费或覆盖用户手动改名。

外部图像服务通常不提供本项目级 exactly-once 保证，因此每个生图任务还要有持久化的 `generation_operations` 记录（业务唯一键为 `jobId`/目标版本/尝试策略），保存 provider request id、已下载文件和 finalize 状态。若供应商支持幂等键，使用该 operation id；若不支持，超时后的重试必须先执行结果查询或人工收口，不能盲目再次生成。资产版本追加使用 operation 唯一约束和目标版本 CAS，避免同一任务或替换任务推进 current pointer 两次。

### 4. 队列适配器必须使用可序列化输入

保留稳定的应用层接口，例如：

```ts
interface TaskQueue {
  run(input: RunTaskInput): Promise<AcceptedTask>;
  cancelJob(jobId: string): Promise<void>;
  cancelThread(projectId: string, threadId: string): Promise<number>;
  cancelProject(projectId: string): Promise<number>;
  shutdown(): Promise<void>;
}
```

`RunTaskInput` 只能包含 `jobId`、`kind`、`projectId`、`artifactId` 和带 `schema_version` 的 JSON payload。payload 必须冻结源 artifact/version、参考文件版本、prompt、模型与关键生成配置，并在入队时完成项目归属校验；不能只保存会随时间变化的 artifact ID。Worker 按 `kind` 查找 handler；不得把 `prepare`/`work` 闭包传入 BullMQ。`CanvasGenerateService` 继续负责图像生成和资产持久化，但要拆出可由 Worker 根据任务 ID 恢复的 prepare/complete 边界。

命名任务保存 generation token、目标 artifact 的名称版本和 `display_name_source` 快照。写回必须使用条件更新：只有名称仍为模型可覆盖状态且版本未变化时才更新；用户手动改名、删除或后续命名请求会使旧 token 失效。不得依赖进程内 `ArtifactDisplayNamer` 的 map 来提供一致性。

### 分布式协调、取消与恢复

- 同项目限流使用持久化配额/租约（或数据库 advisory lock + fencing token），不能依赖单进程 `createTail`/`inflight`；队列级 `Worker.concurrency` 只负责总吞吐。
- 取消先在 PostgreSQL 写入不可逆的 `cancel_requested_at`/状态，再由 Worker 在外部请求前、下载后、资产提交前检查；活动 Job 通过协作取消信号收口，BullMQ `remove` 只用于 waiting/delayed Job。终态采用 CAS，取消与成功竞速时记录 `cancelled_with_side_effect`，不得假装回滚。
- 启动和定时 reconciler 对账 PostgreSQL outbox、`accepted/running` 任务与 Redis waiting/active/completed 状态；stalled Job 必须依据 `generation_operations` 和 finalize 状态恢复或标记人工处理，不能盲目重放外部生成。
- 项目删除通过事务写取消墓碑并让 Worker 丢弃未提交任务；已存在文件/版本按资产清理策略处理，禁止向已删除项目写新世界状态。

### 5. 迁移结果

迁移已直接完成：面板生图、Agent 生图、批量生成和自动命名均通过 PostgreSQL transactional outbox + BullMQ + 独立 Worker 执行。旧的进程内闭包 runner、全局 backend 开关和进程内命名调度器已删除。Redis 只承担可重建的调度状态，PostgreSQL 继续承担任务事实、审计和查询。

## 旧代码移除条件与范围

### 已删除或收缩

- 删除 `AgentJobRunner` 的闭包式 `run({ prepare, work })` API；
- 删除 `createTail`、进程内 active 计数和 `DeskGenerateCapError`，并移除“超限即失败”的产品语义；
- 删除 legacy runner 的 `AbortController` map 及仅服务于它的配置；
- 删除 `LegacyTaskQueue`、feature flag 和 legacy 专用测试；
- 将 `JobWakeService` 改为持久化 BullMQ 终态事件的消费者；
- 不删除历史 `agent_jobs` 记录，也不把 Redis 清理当作数据迁移。

保留 `agent_jobs`/`AgentJobStore`、`TaskStore`、`TaskEventStore`、`CanvasGenerateService` 和 `JobWakeService`，因为它们分别承担业务审计、任务状态、事件消费和领域持久化职责。

## 可靠性与安全约束

- 所有 Worker handler 必须幂等：以 `jobId`/业务唯一键保护资产创建和版本追加；
- 图像任务使用有限重试和指数退避；不可重试的参数/权限错误应立即终止；
- 命名任务默认少量重试，最终失败不影响图像任务；
- 取消同时更新 PostgreSQL 状态并调用 BullMQ `remove`/取消协作信号；已进入不可中断的外部生图请求按终态收口；
- Redis 凭据、TLS、连接数和队列前缀通过环境变量配置，禁止写入仓库；
- 监控批次积压、任务等待时长、执行时长、重试次数、重复副作用和 worker 重启恢复数；
- API 进程与独立 Worker 之间的状态通知通过 PostgreSQL outbox/事件表或 Redis Streams 传递，事件带单调序列号、消费确认和去重键；`JobWakeService` 只消费已持久化事件，不能依赖 Worker 进程内对象直接调用 `EventSink`；
- 所有批量入口都要有项目/租户配额、最大批次大小、队列深度和 provider 速率限制；达到配额时返回可重试的受理失败或分批建议，不能无限制地堆积 pending artifact 和 Redis Job；
- retry policy 必须定义结构化错误分类、最大 attempts、总超时、指数退避、dead-letter/人工恢复状态和每次 attempt 审计。

## 替代方案

### 继续使用进程内 Runner

无需新基础设施，但无法可靠持久化排队任务，也不能支持批量提交、独立 Worker 和跨实例消费。拒绝。

### `pg-boss` 或自建 PostgreSQL 队列

可以减少 Redis 依赖，但需要自行补齐复杂的依赖图、延迟/退避、取消和运维能力。团队已接受 Redis，BullMQ 的生态和 FlowProducer 更贴合批次模型。拒绝。

### Temporal 等工作流平台

提供更强的工作流保证，但引入独立服务、开发模型和运维成本，对当前“资产任务批次”范围过重。保留为未来跨服务长工作流的评估项。

## 后果

正向：批量请求全部受理并持久排队；任务可以重试、取消、暂停后恢复；自动命名与生图拥有统一进度和审计；可独立扩展 Worker。

负向：新增 Redis 运维、Worker 进程和部署配置；需要处理 PostgreSQL 与 Redis 的最终一致性；payload 必须可序列化。**运行时已无 legacy 双后端**；历史文档中的 dual-backend 迁移步骤仅作考古。

## 验收与回滚

### 运行时（已完成）

- 面板 / Agent / 批量 / `artifact.name` 均只走 TaskStore + BullMQ Worker。
- `AgentJobRunner`、`ASYNC_JOB_BACKEND` 开关、进程内起名 kick 已删除。
- 命名是软任务：图像 `succeeded` 后另入 `artifact.name`；命名 provider 无有效名时 name task 仍 `succeeded` 且 `applied=false`，**不得**把图像或批次改成 failed。
- 用户改名 / 过期 `generation_token` 条件写回失败时 `applied=false`，不抛。

### 运维验收（持续）

- outbox：Redis 不可用时任务留在 PG，恢复后 dispatcher 只入队一次（见 reconciler/dispatcher 测试与 runbook）。
- 重复消费不重复追加资产版本（generation_operations + CAS）。
- API/Worker 重启后任务终态确定或 `needs_review`，禁止盲目重放外部生图。
- Bull Board：生产必须配置 `BULL_BOARD_USERNAME` + `BULL_BOARD_PASSWORD`；无凭据时强制只读（见 runbook）。

### 回滚

无 legacy 代码回滚路径。故障时：停新入队、保留 Worker 收口、outbox/reconciler 对账；不删 PG 任务/审计行；Redis 可重建。
