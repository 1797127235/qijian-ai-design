# 高内聚低耦合架构清洗计划

> 状态：执行中（2026-08-06）  
> 相关：`docs/adr/0012-agent-analysis-only.md`

## 目标原则

1. **按变化原因分模块**：同一原因改动的代码放一起。
2. **依赖只向内**：http/realtime → services/modules → domain → infra。
3. **保留 Agent 桌面行动边界**：tools 可暂时为空，注册入口与写路径依赖不得拆除。
4. **先抽领域与边界泄漏，再拆上帝对象**；物理 `modules/` 搬家可后置。

## 产品边界（稳定意图）

| 能力 | 拥有者 | 当前实现 |
|------|--------|----------|
| 对话 + 附件视觉 | Agent | 已落地 |
| 桌面 / Artifact 写入 | Agent tools + 设计师 REST | REST 已落地；**tools 暂空，待重做** |
| 提案导出 | ExportService（REST；未来也可挂 tool） | REST 已落地 |

## 目标模块

```text
domain/     纯规则：空间解析、确认条件、附件限额
chat/       线程、消息、附件绑定、run
files/      对象存储、上传校验、视觉加载
artifact/   版本化事实、createPlaced
desk/       布局、视口、snapshot
analysis/   session 生命周期、prompt、tool 注册（可空列表）
export/     提案包
http/       REST 适配
realtime/   WS 适配
```

前端：`App` 壳 + `useProjectSession` / `useChatSession` / `useDeskActions`。

## 阶段

| Phase | 内容 | 验收 |
|-------|------|------|
| 0 | ADR（桌面能力保留）+ 本计划 + CONTEXT | 文档与产品意图一致 |
| 1 | 保留 tool 边界；清理 dist 残留与无用重复 | `createDeskTools`+deps 仍在；无陈旧 dist tool 误导 |
| 2 | 附件限额单点；文件引用检查去 LIKE | chat/files/前端常量对齐 |
| 3 | domain 确认与空间解析 | ArtifactService 委托 domain |
| 4 | HTTP：`files.getById`、create 带 layout 走 createPlaced | http 不直查 DB |
| 5 | 前端 App 拆 hooks | 行为不变、App 变薄 |
| 6 | 测试 | `npm test`、`build:server` |

## 明确不做

- 拆除 `ToolDependencies` / 从 registry 去掉 artifacts·desks·effects·exports
- 方案 C 资料库
- 本轮重写全部业务 tools（另开 epic，接 domain）
- 一次物理 modules 大搬家

## 进度

- [x] Phase 0：ADR 0012（桌面能力保留）+ 本计划 + CONTEXT
- [x] Phase 1：保留 `createDeskTools` / ToolDependencies；prompt 诚实说明无工具；清理 dist
- [x] Phase 2：`domain/attachment-limits` + 前端 `shared/attachment-limits`；FileStorage 引用检查委托 chat/artifact
- [x] Phase 3：`domain/space-map` + `payload-rules`；ArtifactService 确认规则委托 domain
- [x] Phase 4：HTTP `files.getById`；带 layout 创建走 `createPlaced`；去掉 http 直查 DB
- [x] Phase 5：`useChatSession` / `useDeskActions` 拆分 App
- [x] 测试：`npm test` 全绿；见同晚验证
- [x] 续：session-registry 拆 lifecycle/factory/persister/restore
- [x] 续：chat types + attachment-map；file-storage 拆 inspector/vision
- [x] 续：ChatPanel 子组件；api types/http/socket；HTTP 按资源路由
