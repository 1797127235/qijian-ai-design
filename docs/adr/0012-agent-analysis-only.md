# ADR 0012：Agent 桌面行动能力保留，工具集暂时为空

## 状态

已接受（2026-08-06）  
替代此前「永久分析-only」草案。

## 背景

业务桌面工具实现曾一度删除，但产品意图仍是：智能体是单画布设计桌面的行动者。当前只是**工具尚未重新设计/接入**，不是放弃桌面写权。

## 决策

1. **产品定位不变**：Agent = 设计桌面行动者；对话是指挥通道，Artifact 当前版本 + desk_state 是事实来源。
2. **当前实现状态**：`createDeskTools()` 可暂时返回 `[]`；system prompt 必须禁止**声称**已改桌面，直到工具重新接入。
3. **架构必须保留**：
   - 工具注册入口 `createDeskTools(projectId, deps)`
   - `ToolDependencies` / `ToolContext`（artifacts、desks、effects、exports、emit）
   - 工具执行事件落库与前端 activity 展示（可 generic）
   - composition root 向 registry 注入写路径依赖（即使当前 tools 为空）
4. **恢复工具时的约束**：
   - 领域前置条件放 `domain/`，禁止在各 tool 复制 `spaces`/`regions` 解析
   - 创建+放置走 `createPlaced` 事务
   - 不把不可信用户内容写入 system prompt

## 非决策

- 不在本 ADR 规定具体 tool 清单与参数 schema（另开实现任务）。
- 不引入逐步审批档位（仍默认直接执行，由版本与撤销约束）。

## 后果

- 正向：清洗内聚时不会误删桌面行动边界；恢复 tool 无需重接 composition。
- 负向：当前 runtime 无工具时，写路径依赖对 session 是「预留注入」；必须在 prompt 中诚实说明不能改桌面，避免幻觉。
