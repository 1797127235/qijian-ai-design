> **ARCHIVED.** Runtime is BullMQ-only; authoritative: [ADR 0014](../../../adr/0014-bullmq-task-queue-for-asset-batches.md) + [runbook](../../../runbooks/asset-task-queue.md). This file is historical design notes only.

# 规格：统一资产任务队列

**状态：** PROPOSED（等待人工确认）
**日期：** 2026-08-10
**相关：** [ADR 0014](../../adr/0014-bullmq-task-queue-for-asset-batches.md)、[ADR 0013](../../adr/0013-agent-generate-from-desk.md)

## 已确认假设

1. 所有耗时、依赖外部服务、可重试并产生资产副作用的操作都建模为任务。
2. Agent 工具、面板操作和批量入口共用任务应用层，不各自维护异步实现。
3. 删除资产、用户手动改名和只读查询保持同步命令，不进入 BullMQ。
4. 规格覆盖全部资产任务；实施按任务类型逐步接入，先完成一个端到端切片。
5. Redis 可作为基础设施依赖；PostgreSQL 仍是业务事实、审计和 UI 查询源。

## Objective

建立统一的资产任务系统，替代当前由 `AgentJobRunner` 闭包、面板路由和自动命名器分别承担的后台执行逻辑。

目标用户是从画布面板或 Agent 发起生成的设计师。用户提交多个生成请求时，请求应被可靠受理并排队，而不是因当前并发数达到 2 而直接失败；用户可以查看单任务或批次进度、取消尚未提交副作用的任务，并在服务或 Worker 重启后得到确定终态。

### 纳入任务系统

| 入口/能力 | 业务任务 |
|---|---|
| `generate_from_desk` | `image.generate`，operation=`beside` |
| `replace_on_desk` | `image.generate`，operation=`replace` |
| `text_to_image_on_desk` | `image.generate`，operation=`spawn` |
| 面板普通生成/重试 | `image.generate`，保留相应 operation |
| 面板局部重绘 | `image.generate`，operation=`inpaint` |
| 自动取名 | `artifact.name` 软任务 |
| 批量生成 | 一个 `task_batch` + 多个 `image.generate`，每项可派生 `artifact.name` |

工具名和 HTTP 路由属于 `origin` 元数据，不作为执行架构。任务 handler 依据稳定的业务 `kind` 和 `operation` 工作。

### 不纳入

- `remove_from_desk`、HTTP DELETE：同步破坏性命令；
- 用户手动改名：同步命令，并使排队中的旧命名 token 失效；
- `get_task`、`look_at`、`look_at_desk`：查询；
- 本期不重命名物理表 `agent_jobs`，应用层以通用 `TaskStore` 隔离历史表名；
- 不承诺外部图像供应商无法提供幂等键时的严格 exactly-once 生成。

## User-visible Contract

### 单任务受理

现有 Agent 工具和面板 HTTP 返回协议保持兼容：提交成功表示 `accepted`，不表示图像已完成。

```ts
type AcceptedTask = {
  ok: true;
  async: true;
  status: "accepted";
  task_id: string;
  batch_id?: string;
  /** 兼容现有入口名称，例如 generate_from_desk。 */
  kind: string;
  task_kind: "image.generate" | "artifact.name";
  artifact_id?: string;
};
```

### 批次受理

一次批量提交在一个 PostgreSQL 事务内创建 `task_batch`、全部任务、pending artifact 和 outbox 记录。批次 `total` 只统计用户要求生成的图像数量；命名软任务不增加进度分母。

批次状态：

- `accepted`：任务已持久化，尚未开始；
- `running`：至少一个图像任务运行，且仍有非终态任务；
- `succeeded`：全部图像成功，命名可以有失败；
- `partial_failed`：至少一个图像成功且至少一个图像失败；
- `failed`：所有未取消图像均失败；
- `cancelled`：没有图像成功且剩余任务全部取消；
- `cancelled_with_side_effect`：取消请求后仍有不可撤销的图像副作用完成。

批次提交不得因执行并发已满而失败；它可以因批次大小、项目配额、队列容量、验证或权限失败而拒绝。

## Task Contract

任务 payload 使用 Zod 校验并带版本。任务必须冻结执行所需输入，不能在 Worker 执行时重新解释用户已变化的选择状态。

```ts
type ImageGenerateTaskV1 = {
  schema_version: 1;
  kind: "image.generate";
  operation: "beside" | "replace" | "spawn" | "inpaint";
  project_id: string;
  task_id: string;
  source?: { artifact_id: string; version_id: string; file_id: string };
  references: Array<{ artifact_id: string; version_id: string; file_id: string }>;
  target_artifact_id?: string;
  target_version: number;
  prompt: string;
  model: string;
  origin: { type: "agent" | "panel" | "batch"; name: string };
};
```

`artifact.name` payload包含 artifact id、名称版本、generation token、`display_name_source` 快照和用于命名的稳定文本/图像结果引用。写回使用 SQL 条件更新，用户名称或更新后的 token 永远优先。

## State And Consistency

### PostgreSQL

PostgreSQL 保存：

- `agent_jobs`：兼容现有任务状态与查询；新增 backend、batch、role、queue id、cancel intent 等字段；
- `task_batches`：批次状态和去重后的进度；
- `task_queue_outbox`：事务性待入队记录；
- `generation_operations`：外部请求、attempt、下载结果和 finalize 状态；
- 持久化任务事件/outbox：供 UI、Agent wake 和审计消费。

### Redis/BullMQ

Redis 只保存调度状态。BullMQ Job ID 使用业务 task id；重复 outbox 投递必须解析为同一逻辑 Job。Redis 数据丢失后由 PostgreSQL reconciler 判断可重建、人工处理或终止，UI 不直接查询 Redis。

### 副作用幂等

- 资产版本追加以 generation operation 建立唯一约束；
- replace/inpaint 使用目标版本 CAS 或 fencing token，迟到任务不能覆盖更新结果；
- provider 支持幂等键时传 operation id；
- provider 状态不明确时不盲目重试，转入 `needs_review`/dead-letter；
- 文件已下载但数据库未 finalize 时，恢复流程复用已下载结果。

### 取消

取消首先持久化 `cancel_requested_at`。Worker 在调用 provider 前、响应后、下载后和资产提交前检查取消意图。waiting/delayed Job 可移除；active Job 使用协作信号。已发生的外部调用或资产提交不会被描述成“已回滚”。

### 并发与背压

- 默认项目级运行上限仍为 2，但超出的有效任务进入等待而不是失败；
- Worker concurrency 是全局上限，项目租约/配额提供跨 Worker 的项目级限制；
- 批次入口必须限制单批大小、项目未完成任务数和 provider 请求速率；
- 调度需要避免一个大项目永久饿死其他项目。

## Tech Stack

- Node.js 22.19+
- TypeScript / ESM
- PostgreSQL 16、Drizzle ORM `^0.45`
- BullMQ `5.x`
- ioredis `5.x`
- Redis 7.x（Docker Compose 本地运行）
- Zod `^4.4`
- Vitest `^4.1`

依赖的准确 patch 版本由 `npm install` 写入 `package-lock.json`，不得手工猜测或编辑 lockfile。

## Commands

```bash
# 安装依赖（实施阶段）
npm install bullmq@^5 ioredis@^5

# 基础设施
docker compose up -d postgres redis

# 数据库
npm run db:generate
npm run db:migrate

# 开发进程
npm run dev:server
npm run dev:worker
npm run dev

# 定向与全量验证
npx vitest run apps/server/src/tasks
npm test
npm run build:server
npm run build
```

仓库当前没有 lint script；本规格不虚构 lint 命令。`dev:worker` 在实施时加入 `package.json`。

## Project Structure

```text
apps/server/src/tasks/
  types.ts                    # 版本化 payload、状态机和公开 DTO
  task-queue.ts               # 应用层 TaskQueue 接口
  task-store.ts               # PostgreSQL 业务状态
  legacy-task-queue.ts        # 迁移期适配器
  handlers/
    image-generate.ts         # 所有图像 operation 的执行入口
    artifact-name.ts          # 条件写回的命名软任务
  bullmq/
    connection.ts             # Redis 连接生命周期
    queue.ts                  # Queue/FlowProducer
    worker.ts                 # handler dispatch
    dispatcher.ts             # outbox -> BullMQ
    reconciler.ts             # PG/Redis/operation 对账
apps/server/src/task-worker.ts # 独立 Worker 进程入口
apps/server/src/db/schema.ts   # 任务、批次、outbox、operation 表
apps/server/drizzle/           # 生成的 SQL 迁移
apps/server/src/**/*.test.ts   # 与实现同目录的测试
docs/adr/0014-*.md             # 架构决策与退出条件
```

现有 `apps/server/src/agent/async-job/` 在迁移期保留。新通用任务层不能放在 `agent/` 下，因为面板和批量入口同样使用它。

## Code Style

遵循现有 ESM、显式类型和 colocated tests。入口先解析版本化 payload，再调用 handler；禁止把闭包或未验证的 `unknown` 传入 Worker。

```ts
const taskPayload = z.discriminatedUnion("kind", [
  imageGenerateTaskV1Schema,
  artifactNameTaskV1Schema,
]);

export async function handleTask(raw: unknown, context: TaskHandlerContext) {
  const task = taskPayload.parse(raw);
  return handlers[task.kind](task, context);
}
```

命名：数据库列使用 `snake_case`，TypeScript 使用 `camelCase`，业务 kind 使用带命名空间的稳定字符串（如 `image.generate`）。复杂一致性代码只注释“不变量/原因”，不复述语句行为。

## Testing Strategy

### 单元测试

- payload 版本和所有 operation 校验；
- task/batch 状态机与重复终态事件去重；
- retry/error 分类；
- 命名 token、用户改名和 replace 竞态；
- 项目级配额与公平调度决策。

### PostgreSQL + Redis 集成测试

- 同事务创建任务、pending artifact 和 outbox；
- outbox 重复发送只产生一个逻辑 BullMQ Job；
- Worker 重复消费只追加一个资产版本；
- Worker 在 provider 响应后崩溃，恢复不盲目再次生成；
- replace/inpaint 迟到结果不能推进过期 current version；
- 取消、项目删除和 active Job 完成的竞态；
- 批次计数在 retry/重复事件下保持正确；
- Worker/API 分进程时事件与 `JobWakeService` 可恢复消费。

### 回归与故障测试

- legacy 与 BullMQ 返回兼容的 accepted/task DTO；
- Redis 暂时不可用时任务保留在 outbox 并最终入队；
- Redis 数据丢失、Worker SIGKILL、API 重启后 reconciler 给出确定处理；
- feature flag 回切只影响新任务，既有任务按 `queue_backend` 收口；
- 现有 Agent 工具、面板生成、局部重绘和自动取名回归测试通过。

不以单一覆盖率数字代替上述故障场景；每个状态转换和副作用边界必须至少有一个可复现测试。

## Boundaries

### Always

- PostgreSQL 先持久化业务任务和 outbox，再返回 accepted；
- 使用版本化、可序列化、经过归属校验的 payload；
- 对资产追加、命名和终态写入使用唯一约束/CAS；
- 每个任务记录 backend、attempt、结构化错误和可审计终态；
- 每个切片先通过定向测试，再运行服务端和全量测试/构建。

### Ask First

- 改变现有 Agent tool/HTTP 的公开返回结构；
- 重命名或删除 `agent_jobs`，修改历史任务数据；
- 改变默认项目并发、批次上限或任务保留时间；
- 删除 legacy adapter、feature flag 或旧测试；
- 修改 CI/CD 或生产 Redis 部署拓扑。

本规格和 ADR 已批准引入 BullMQ/ioredis、Redis Compose 服务及新增数据库表；其具体 migration 仍需在实施任务中审查。

### Never

- 把 Redis/BullMQ 状态作为 UI 或审计的唯一事实源；
- 在 payload 中保存闭包、AbortController、密钥或未限制的大型 base64；
- 对结果不明确的外部生成请求进行无条件自动重试；
- 让模型命名覆盖用户手动名称；
- 为完成迁移而删除失败测试或直接清空旧任务/Redis；
- 在 legacy/BullMQ 尚有 active/accepted/outbox 任务时删除旧实现。

## Success Criteria

1. Agent 三个生图工具、面板生成/重试/局部重绘和自动命名最终都通过统一 `TaskQueue` 提交，不再拥有独立后台 runner。
2. 提交 N 个有效图像请求时创建一个批次和 N 个图像任务；运行上限为 2 时其余任务等待，不因并发帽失败。
3. Redis 在 PostgreSQL 提交后不可用时，任务保持可查询的 accepted/enqueue-pending 状态，并在恢复后只入队一次。
4. 同一 task 被重复投递或消费不会产生两个 artifact/version/name 写入。
5. Worker/API 重启后，没有永久悬挂的 accepted/running 任务；每项会恢复、失败或进入可见的人工处理状态。
6. 用户手动改名后，任何排队中或迟到的命名任务都不能覆盖该名称。
7. 取消和项目删除不会产生未记录的迟到副作用；无法撤销的结果以明确终态展示。
8. UI 和 Agent 只根据 PostgreSQL 任务/批次及持久化事件显示状态，Worker 跨进程不会丢失最终通知。
9. 灰度期间可以停止新 BullMQ 入队并继续收口旧 BullMQ 任务；满足 ADR 0014 的排空指标后才能删除 legacy。
10. 定向、全量测试以及前后端构建通过；已知的服务端基线类型错误必须先修复，不能归因于队列迁移。

## Open Questions

以下参数在进入 PLAN 前需要确认：

1. 单批图像任务上限建议为 **20**，单项目未完成图像任务上限建议为 **100**，是否接受？
2. 任务与批次终态记录建议永久保留业务摘要；BullMQ completed/failed Job 建议保留 **7 天**，是否接受？
3. 第一实施切片建议选择面板 `generate-image`（无需 Agent session，集成面较小），还是 `generate_from_desk`（能直接替换最痛的旧 Runner）？
4. provider 返回超时且无法查询结果时，建议进入 `needs_review`，默认不自动重试生成，是否接受？
