# 项目记忆行为（极简）

**状态：** 极简实现  
**上游：** [ADR 0016](../adr/0016-project-design-memory.md)

## 不变式

1. 当前记忆只有一份，存在 `project_memories`。
2. 写入立即生效；同 `stable_key` 后写覆盖。
3. 画布方向 A/B 未选定前不要写入。
4. 生图冻结受理时快照；之后改记忆不影响已入队任务。
5. 不自动从生成结果反写记忆。

## 流水线

```text
对话 / REST
  → record / forget
  → project_memories 更新 revision + compiled_context
  → 对话注入 [PROJECT_MEMORY]
  → 生图受理 freeze → generation_memory
  → Worker 只用 payload
```

## 工具

- `record_project_memory`：写/覆盖
- `forget_project_memory`：删
- `inspect_project_memory` / `search_project_memory`：读

## 测试

- `apps/server/src/agent/memory/domain.test.ts`
- `apps/server/src/agent/tools/memory.test.ts`
- `apps/server/src/agent/memory/service.integration.test.ts`（需 DATABASE_URL）
