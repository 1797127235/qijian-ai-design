# Implementation Plan: 人看的缩略图（项目封面 + 画布 Minimap)

## Overview

两处人看缩略图，与 agent `desk_overview` 完全独立：① Home 项目列表封面（server 预渲染 PNG 防抖存库）;② 画布左下角可拖 minimap（前端实时）。Spec 见 `docs/human-thumbnails-spec.md`，意图见 `docs/intent/human-thumbnails.md`。

## Architecture Decisions

- **渲染分侧**：封面 server(`@napi-rs/canvas` 复用拼板）,minimap 前端 DOM 缩放（不用 canvas,`view` 变化只动视口框样式，60fps 无压力）
- **renderer 加风格变体**:`renderDeskOverview` 加 `style: "agent" | "human"`（默认 `"agent"` 零行为变化）,human 去掉 alias 角标/选中描边，连线淡化保留
- **封面 = 派生缓存**:`projects.cover_file_id → stored_files.id` + `cover_revision text`，按 `revisionOf(snapshot)` 对比跳过重复渲染；丢了可重算
- **封面经 FileStorage.put 入 stored_files**：与普通文件同生命周期（删项目级联清磁盘）；注册 reference checker 防 `deleteUnattached` 误扫（沿用 `index.ts:52` 的 `setReferenceCheckers` 模式）
- **变更感知用回调注册，不做依赖反转**:`DeskStateService` / `ArtifactService` / `CanvasGenerateService` 暴露可选 `onDeskChanged(projectId)` 钩子（沿用 `setReferenceCheckers` 风格）,cover service 在组合根（`index.ts`）订阅。这样 UI 路由与 agent 工具两条写路径都能触发，且 service 间无循环依赖
- **viewport 变化不触发封面**:`PATCH /desk`（仅视口）不改桌面内容，不调度
- **minimap 几何全部纯函数**(`minimap-geometry.ts`)，复用 `nodeSize`(`connection-geometry.ts`）与 `screenToWorld`(`geometry.ts`)，组件只做渲染和 pointer 事件

## 关键实现事实（已核实）

- `FileStorage.put(projectId, filename, mediaType, bytes)` 可直接存封面 PNG(`file-storage.ts:80`)
- `revisionOf(snapshot)` 在 `desk-context.ts:94`，可直接复用
- `listProjects()` 返回 projects 全行（`desk-state-service.ts:40`)，加列后 `coverFileId` 自动随 select * 返回；前端 `ProjectSummary` 类型需同步加字段
- 视口 `{x, y, zoom}`,stage CSS `translate+scale`(`Desk.tsx:385`)；可见世界区 = `screenToWorld` 四角
- minimap 挂 `Desk.tsx` 内（有 `view`/`setView`/`objects`/`connections`/`vpRef`)，容器尺寸用 `vpRef` + ResizeObserver

## Task List

### Phase 1: 封面渲染与存储（server)

- [ ] Task 1: renderer human 风格变体 + 单测
- [ ] Task 2: schema 加列 + migration 0018
- [ ] Task 3: project-cover-service（防抖调度 + 渲染 + 存取）+ 单测
- [ ] Task 4: 变更钩子接线（3 个 service + 组合根）+ listProjects 带 coverFileId

### Phase 2: 封面展示（frontend)

- [ ] Task 5: Home.tsx 封面 `<img>` + 无封面回退骨架 + ProjectSummary 类型

### Phase 3: Minimap(frontend)

- [ ] Task 6: minimap-geometry 纯函数 + 单测
- [ ] Task 7: Minimap 组件渲染（物件块/连线/视口框）+ 样式
- [ ] Task 8: minimap 拖拽交互（视口框拖动 + 点击居中）

### Phase 4: 验收

- [ ] Task 9: 全量验证（`npm test` / 双 build / 手测两场景）+ agent 回归确认

## Risks & Mitigations

| 风险 | 缓解 |
|------|------|
| 封面渲染拖慢 server | 全异步防抖，绝不阻塞 API；渲染失败只记日志留旧图 |
| 生图高频完成导致频繁渲染 | 8s 防抖合并 + revision 相同跳过 |
| stored_files 封面被当附件扫/被用户文件列表露出 | reference checker 注册；filename 固定 `desk-cover.png` 便于识别 |
| minimap 与画布 transform 不同步 | 几何只认 `view` + `nodeSize` 单一事实源，纯函数单测覆盖 |
| agent renderer 回归 | `style` 默认 `"agent"`，现有 `desk-overview-renderer.test.ts` 必须原样全绿 |

## Verification Checkpoints

- Task 1 后：`npx vitest run apps/server/src/services/desk-overview-renderer.test.ts`（含新增 human 断言）
- Task 3 后：`npx vitest run apps/server/src/services/project-cover-service.test.ts`
- Task 4 后：`npm test` 全绿 + 手测「上传图 → 等 8s → Home 出封面」
- Task 6 后：`npx vitest run src/desk/minimap-geometry.test.ts`
- Task 8 后：手测拖视口框/点击跳转/缩放时框反比变化
- Task 9:`npm test` + `npm run build` + `npm run build:server` 全绿
