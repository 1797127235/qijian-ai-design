# Implementation Plan: 统一资产任务队列

## Overview

按 [ADR 0014](../docs/adr/0014-bullmq-task-queue-for-asset-batches.md)（现行）与归档规格 [archive/superpowers/specs/2026-08-10-unified-asset-task-queue-design.md](../docs/archive/superpowers/specs/2026-08-10-unified-asset-task-queue-design.md)（考古），用 PostgreSQL + transactional outbox + BullMQ/Redis 建立通用资产任务层。所有生图入口与自动命名最终提交版本化任务；PostgreSQL 保存业务状态，Redis 只负责调度。BullMQ 是唯一运行时后端。

## Dependency Graph

```text
服务端基线可构建
  -> 任务 payload/状态机
    -> 数据库 schema/migration
      -> TaskStore + transactional outbox
        -> BullMQ adapter + dispatcher/reconciler
          -> image.generate handler + panel slice
            -> cancellation/leases/events
              -> Agent tools
              -> artifact.name
              -> task batches
                -> migration complete
```

## Architecture Decisions

- 通用任务代码放在 `apps/server/src/tasks/`，不放在 `agent/`。
- 内部 kind 使用 `image.generate` / `artifact.name`；现有返回字段 `kind` 保持兼容，并增加 `task_kind`。
- 接受任务的事务同时写业务任务、pending artifact 与 `task_queue_outbox`。
- BullMQ `jobId` 等于业务 task id；Dispatcher 和 Worker 都必须支持重复执行。
- 外部请求结果不明确时进入 `needs_review`，不盲目重试。
- 默认项目 active 图像任务上限 4、Worker 全局并发 4、单批 20、单项目未完成 100；BullMQ 终态保留 7 天。
- 第一垂直切片使用面板 `generate-image`；验证队列可靠性后接 Agent 工具。
- 不在本计划中删除用户现有自动命名改动或重命名 `agent_jobs`。

## Task List

### Phase 0: Baseline

- [x] Task 0: 修复现有服务端类型构建错误，记录干净基线
- [x] Task 1: 添加 BullMQ/ioredis、Redis Compose 与安全默认配置

### Checkpoint: Baseline

- [x] `npm run build:server` 通过
- [x] `docker compose config` 通过
- [x] Redis 健康检查通过

### Phase 1: Contracts And Persistence

- [x] Task 2: 用 TDD 实现版本化 payload、任务/批次状态机与 retry 分类
- [x] Task 3: 增加 task batch/outbox/generation operation schema 与迁移
- [x] Task 4: 用 TDD 实现 TaskStore 的事务受理、CAS 终态和 outbox claim

### Checkpoint: Persistence

- [x] payload/state/store 定向测试通过
- [x] migration 可应用到本地 PostgreSQL
- [x] 重复受理和重复终态不会重复计数

### Phase 2: BullMQ Vertical Slice

- [x] Task 5: 实现 BullMQ connection、queue adapter 和确定性 job id
- [x] Task 6: 实现 outbox dispatcher、reconciler 和可恢复事件发布
- [x] Task 7: 实现 `image.generate` handler 的 operation 幂等与版本 CAS
- [x] Task 8: 将面板 `generate-image` 接入 feature-flagged TaskQueue 和独立 Worker

### Checkpoint: First Slice

- [x] Redis 不可用时 accepted task 留在 outbox，恢复后只入队一次（dispatcher/reconciler + runbook）
- [x] 重复消费只追加一个资产版本（generation_operations + CAS 测试）
- [x] API/Worker 重启后任务得到确定终态或 `needs_review`（worker 幂等 finalize + reconciler）
- [x] BullMQ Worker 默认路径通过回归

### Phase 3: Coordination And Remaining Producers

- [x] Task 9: 实现项目级租约/配额、持久取消和 late-side-effect 终态
- [x] Task 10: 接入持久事件、JobWakeService 和 Agent 三个生图工具
- [x] Task 11: 将自动命名改为 `artifact.name` 软任务和 SQL 条件写回
- [x] Task 12: 实现批次受理、进度去重和最大 20/项目 100 配额

### Checkpoint: Unified Tasks

- [x] 面板、Agent、命名和批次均通过 TaskQueue
- [x] 命名失败不污染图像/批次成功（name soft-succeed `applied=false`）
- [x] 用户手动改名不可被迟到命名覆盖（generation_token 测试）
- [x] active=2 时额外任务排队而非并发帽失败

### Phase 4: Migration Completion

- [x] Task 13: 故障注入、保留策略、观测指标和运维文档
- [x] Task 14: 切换 BullMQ-only 并删除旧 runner/feature flag

### Checkpoint: Complete

- [x] 运行时 BullMQ-only（无 legacy 路由/runner）
- [x] ADR 0014 / runbook / README 与实现一致（2026-08-10 审查收口）
- [ ] 全量 `npm test` + `npm run build:server` + `npm run build`（每次发布前跑）
- [ ] 生产环境配置 Bull Board 凭据（见 runbook）

## Risks And Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| PG/Redis 双写孤儿 | 高 | transactional outbox + deterministic job id + reconciler |
| provider 超时后重复生图/扣费 | 高 | generation operation、幂等键、`needs_review` |
| 多 Worker 同卡竞争 | 高 | project lease + target version CAS/fencing |
| 取消后迟到副作用 | 高 | durable cancel intent、检查点、明确 late-side-effect 终态 |
| 自动命名覆盖用户名称 | 高 | generation token + SQL 条件更新 |
| 多进程任务路由混乱 | 高 | 每任务 `queue_backend`，BullMQ-only 运行时和 reconciler |
| 当前工作树含其他未提交修改 | 中 | 小范围 patch，不重置或覆盖已有文件，逐任务读差异 |
| 功能范围过大 | 中 | 先交付面板切片；每个 checkpoint 保持可验证 |

## Verification Strategy

- 每个行为任务遵循 RED -> GREEN -> REFACTOR。
- 单元测试使用 `npx vitest run <test-file>`。
- Redis/PostgreSQL 集成测试只访问 localhost，不调用真实图像 provider。
- 每 2-3 个任务运行 `npm run build:server` 和相关回归测试。
- 最终运行全量前后端测试与构建。

## Approval

实现已完成；后续只需补齐部署环境中的重启/故障注入验证。
