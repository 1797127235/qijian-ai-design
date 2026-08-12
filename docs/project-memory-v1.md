# 项目记忆（极简）

## 作用

每项目一份**当前记忆**：助手直接读写，写入即生效，同 `stable_key` 后写覆盖。  
生图受理时把当前记忆冻结进任务 payload，Worker 只读快照。

不做：候选/采用关卡、事件链、冲突表、召回轨迹表、outcome 表、版本历史表。

## 存储

PostgreSQL 单表 `project_memories`（迁移 `0025_project_memory_minimal.sql`，会 DROP 旧 memory_* 表）：

| 列 | 含义 |
|----|------|
| `project_id` | PK，级联删项目 |
| `revision` | 每次实质写入 +1 |
| `entries` | `stable_key → { family, summary, body, updatedAt }` |
| `compiled_context` | 注入/生图用的编译文本 |
| `updated_at` | 更新时间 |

## 代码

| 模块 | 职责 |
|------|------|
| `apps/server/src/agent/memory/domain.ts` | upsert/remove/search/compile |
| `apps/server/src/agent/memory/service.ts` | PG 读写、行锁、freeze |
| `apps/server/src/agent/tools/memory.ts` | Agent 工具 |
| `apps/server/src/http/routes/memory.ts` | REST |
| 生图 submission | `freezeForGeneration` → `generation_memory` |

## API

```text
GET    /api/projects/:id/memory
GET    /api/projects/:id/memory/search?q=...
POST   /api/projects/:id/memory          { stableKey, family, summary, body? }
DELETE /api/projects/:id/memory/:stableKey
```

Agent 工具：

```text
inspect_project_memory
search_project_memory
record_project_memory
forget_project_memory
```

## 生成冻结

任务 payload `generation_memory`：

```text
checkpoint_revision
stable_keys
compiled_design_context
```

Worker 不查最新记忆；冻结失败则生图受理失败。

## 部署注意

- `0025` **DROP** 全部旧 `memory_*` 表，无数据迁移。
- 生图任务 `generation_memory` 字段已收窄；部署后须 **清空/重投** 队列中旧 image 任务，否则 Worker `taskPayloadSchema.parse` 会失败。

## 验证

```bash
npm run db:migrate
npm test
```
