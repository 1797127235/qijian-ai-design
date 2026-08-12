# ADR 0016：项目设计记忆（极简）

## 状态

已修订为极简实现（2026-08-11）。旧 8 表表模型废弃，无数据迁移兼容。

## 决策

1. **每项目一行当前态**（`project_memories`），`entries` 为 stable_key 映射。
2. **助手直接记录**：`record_project_memory` / REST POST 写入即生效；同 key 覆盖。
3. **删除显式**：`forget_project_memory` / DELETE。
4. **生图冻结**：受理时写入 `generation_memory`（revision + stable_keys + compiled 文本）；Worker 只读 payload。
5. **不做**：事件/候选/版本/冲突/checkpoint 多表、召回轨迹、生成 outcome、设计师采用关卡。

## 代码位置

- 领域与服务：`apps/server/src/agent/memory/`
- 工具：`apps/server/src/agent/tools/memory.ts`
- 迁移：`0025_project_memory_minimal.sql`（DROP 旧表）
- 运行说明：`docs/project-memory-v1.md`

## 代价

- 无版本历史与证据链；覆盖即丢旧正文。
- 无 outcome 复核；漂移诊断依赖对话与任务快照。
- 适合当前「直接记、直接用」产品，不适合强审计场景。
