# Tasks: 统一资产任务队列

## Task 0: 修复服务端构建基线

**Acceptance:** `TraceUsageTotals`/`TokenUsageAggregate` 类型不兼容被正确修复，不改变 tracing 行为。

**Verify:** `npm run build:server`；相关 tracing/session 测试。

**Files:** `apps/server/src/agent/session-factory.ts`，必要时一个相邻类型文件/测试。

**Dependencies:** None。**Scope:** S。

## Task 1: 队列依赖和本地基础设施

**Acceptance:** 安装 BullMQ/ioredis；Compose Redis 有健康检查；BullMQ-only Worker script 与可运行入口交付。

**Verify:** `docker compose config`；配置单测；`npm run build:server`。

**Files:** `package.json`、`package-lock.json`、`docker-compose.yml`、`.env.example`、`apps/server/src/config.ts`。

**Dependencies:** Task 0。**Scope:** M。

## Task 2: 任务契约和状态机

**Acceptance:** Zod 拒绝未知 schema/kind/operation；批次状态和 retry 分类符合规格；重复终态事件不重复计数。

**Verify:** 先观察新增测试 RED，再运行 `npx vitest run apps/server/src/tasks/types.test.ts`。

**Files:** `apps/server/src/tasks/types.ts`、`apps/server/src/tasks/types.test.ts`、`apps/server/src/tasks/state-machine.ts`、`apps/server/src/tasks/state-machine.test.ts`。

**Dependencies:** Task 1。**Scope:** M。

## Task 3: 任务持久化 schema

**Acceptance:** `agent_jobs` 扩展字段及 batch/outbox/generation operation/event 表存在；唯一约束支持幂等和 CAS；迁移由 Drizzle 生成。

**Verify:** `npm run db:generate`；`npm run db:migrate`；`npm run build:server`。

**Files:** `apps/server/src/db/schema.ts`、新 migration、Drizzle metadata。

**Dependencies:** Task 2。**Scope:** M。

## Task 4: Transactional TaskStore

**Acceptance:** 同事务创建 task/pending/outbox；outbox 可安全 claim/retry；任务和批次终态使用 CAS/去重。

**Verify:** TaskStore 单元/集成测试；PostgreSQL migration 后测试。

**Files:** `apps/server/src/tasks/task-store.ts`、`task-store.test.ts`、`task-queue.ts`，必要时 DB test helper。

**Dependencies:** Task 3。**Scope:** M。

## Task 5: BullMQ adapter

**Acceptance:** Redis connection 可控关闭；Queue/FlowProducer 使用稳定 job id 和保留策略；BullMQ 为唯一 backend。

**Verify:** mock/localhost Redis 测试；重复 add 得到同一逻辑任务。

**Files:** `apps/server/src/tasks/bullmq/connection.ts`、`queue.ts`、对应测试、`apps/server/src/tasks/index.ts`。

**Dependencies:** Task 4。**Scope:** M。

## Task 6: Dispatcher、Reconciler 和事件

**Acceptance:** outbox 投递崩溃窗口可恢复；PG/Redis 缺失状态被确定分类；事件重复消费可去重。

**Verify:** Redis 中断/恢复和重复 dispatcher 集成测试。

**Files:** `dispatcher.ts`、`dispatcher.test.ts`、`reconciler.ts`、`reconciler.test.ts`、事件存储文件。

**Dependencies:** Task 5。**Scope:** M。

## Task 7: Image handler 幂等边界

**Acceptance:** handler 可从 payload 恢复；同 operation 只生成/追加一次；replace/inpaint 迟到结果 CAS 失败且不覆盖 current version。

**Verify:** RED/GREEN handler 测试，使用 fake provider；现有 CanvasGenerateService 测试通过。

**Files:** `handlers/image-generate.ts`、对应测试、`canvas-generate-service.ts`、相关测试、generation operation store。

**Dependencies:** Task 6。**Scope:** M。

## Task 8: 面板垂直切片和 Worker

**Acceptance:** 面板生成提交序列化任务；独立 Worker 完成 pending artifact。

**Verify:** route/worker 集成测试；手工使用本地 Redis/Postgres；服务端构建。

**Files:** `apps/server/src/task-worker.ts`、`apps/server/src/http/routes/desk.ts`、`apps/server/src/http/app.ts`、`apps/server/src/index.ts`、相关测试。

**Dependencies:** Task 7。**Scope:** M。

## Task 9: 分布式配额和取消

**Acceptance:** 同项目最多 2 个 active 图像任务；额外任务等待；取消意图跨进程可见；late side effect 有明确终态。

**Verify:** 多 Worker/取消竞态集成测试。

**Files:** lease/quota/cancel 模块及测试、TaskStore 状态更新。

**Dependencies:** Task 8。**Scope:** M。

## Task 10: Agent 生图接入

**Acceptance:** 三个 Agent 工具都提交 `image.generate`；现有 `kind`/accepted DTO 兼容；JobWake 可消费持久事件。

**Verify:** generate tool、protocol、JobWake 测试和服务端构建。

**Files:** `run-desk-generate.ts`、任务 adapter、`job-wake.ts`、相应测试、依赖装配文件。

**Dependencies:** Task 9。**Scope:** M。

## Task 11: 自动命名软任务

**Acceptance:** 生图成功派生 `artifact.name`；失败不改变图像终态；用户改名或新 token 使迟到命名写回失败。

**Verify:** 命名竞态、replace 失败和用户手动改名单元/集成测试。

**Files:** `handlers/artifact-name.ts`、对应测试、`artifact-display-namer.ts`、`artifact-service.ts`、必要的 store。

**Dependencies:** Task 10。**Scope:** M。

## Task 12: 任务批次

**Acceptance:** 一次提交原子创建 batch + N tasks；上限 20/项目未完成 100；进度去重且命名不进入分母。

**Verify:** batch service/route 集成测试；active=2 时其余任务等待。

**Files:** batch service、route、DTO/types、测试、TaskStore batch methods。

**Dependencies:** Tasks 9, 11。**Scope:** M。

## Task 13: 故障验证和运维

**Acceptance:** 有 Redis 中断、Worker SIGKILL、重复投递、needs_review 和保留策略测试；README/env/ADR 与实际命令一致。

**Verify:** 故障测试、`npm test`、两个 build 命令。

**Files:** integration tests、`README.md`、`.env.example`、ADR/spec，必要的观测模块。

**Dependencies:** Task 12。**Scope:** M。

## Task 14: BullMQ-only 迁移完成

**Acceptance:** 删除旧 runner 与 backend feature flag；API、Worker、任务查询和取消全部走 BullMQ/持久化状态。

**Verify:** 全量测试和构建。

**Files:** 启动配置、旧 runner 删除文件、任务取消/Worker 接线。

**Dependencies:** Task 13。**Scope:** M。

## Status

- [x] Plan approved
- [x] Task 0
- [x] Task 1
- [x] Task 2
- [x] Task 3
- [x] Task 4
- [x] Task 5
- [x] Task 6
- [x] Task 7
- [x] Task 8
- [x] Task 9
- [x] Task 10
- [x] Task 11
- [x] Task 12
- [x] Task 13
- [x] Task 14
