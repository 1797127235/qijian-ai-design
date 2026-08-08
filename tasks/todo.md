# Tasks: 人看的缩略图（项目封面 + 画布 Minimap)

> Spec: `docs/human-thumbnails-spec.md` · Plan: `tasks/plan.md`

## Task 1: renderer human 风格变体 + 单测

**Description:** `desk-overview-renderer.ts` 的 `OverviewRenderInput` 加 `style?: "agent" | "human"`（默认 `"agent"`)。human 风格：不画 alias 角标、不画选中高亮描边（`highlighted` 输入被忽略）；连线颜色更淡；其余拼板/点阵/灰块逻辑共享。不改任何现有默认路径。

**Acceptance criteria:**
- [ ] 省略 `style` 时输出与现状逐字节一致（现有测试不动全绿）
- [ ] `style: "human"` + `highlighted: true` 的 tile 无蓝色描边、无角标
- [ ] human 风格仍渲染连线、点阵背景、lifecycle 灰块

**Verification:**
- [ ] `npx vitest run apps/server/src/services/desk-overview-renderer.test.ts` 通过

**Dependencies:** None

**Files likely touched:**
- `apps/server/src/services/desk-overview-renderer.ts`
- `apps/server/src/services/desk-overview-renderer.test.ts`

---

## Task 2: schema 加列 + migration 0018

**Description:** `projects` 表加 `cover_file_id uuid`（nullable,FK → `stored_files.id`,onDelete set null）与 `cover_revision text`(nullable)。`drizzle-kit generate` 生成 `0018_*.sql`,migrate 应用。

**Acceptance criteria:**
- [ ] `apps/server/src/db/schema.ts` projects 含两列
- [ ] `apps/server/drizzle/0018_*.sql` 生成且 `npm run db:migrate` 成功
- [ ] 既有项目行 cover 两列为 null,`GET /api/projects` 不炸

**Verification:**
- [ ] `npm run db:generate && npm run db:migrate` 成功；`npm test` 全绿

**Dependencies:** None（可与 Task 1 并行）

**Files likely touched:**
- `apps/server/src/db/schema.ts`
- `apps/server/drizzle/0018_*.sql`（生成）

---

## Task 3: project-cover-service（防抖调度 + 渲染 + 存取）+ 单测

**Description:** 新建 `apps/server/src/services/project-cover-service.ts`:
- `schedule(projectId)`:8s 内存防抖（每项目一计时器），到期后 `renderNow(projectId)`
- `renderNow(projectId)`:`snapshot` → `revisionOf` 与 `cover_revision` 相同则跳过 → 读 ready 图字节 → `renderDeskOverview({ style: "human" })` → `files.put(projectId, "desk-cover.png", "image/png", png)` → 更新 projects.cover_file_id/cover_revision
- 无 ready 图 / 渲染失败：记日志，保留旧封面，不抛错
- 时钟与 renderer 可注入（单测用假时钟假 renderer)

**Acceptance criteria:**
- [ ] 防抖窗口内 3 次 schedule 只渲染 1 次
- [ ] revision 未变时跳过渲染（renderer 不被调用）
- [ ] 无 ready 图时不写库、不清旧封面
- [ ] 渲染抛错不向上传播

**Verification:**
- [ ] `npx vitest run apps/server/src/services/project-cover-service.test.ts` 通过

**Dependencies:** Task 1, Task 2

**Files likely touched:**
- `apps/server/src/services/project-cover-service.ts`（新建）
- `apps/server/src/services/project-cover-service.test.ts`（新建）

---

## Task 4: 变更钩子接线 + listProjects 带 coverFileId

**Description:**
- `DeskStateService` 加可选 `onDeskChanged?: (projectId: string) => void`(setter 注册，沿用 `setReferenceCheckers` 风格）;`placeObject`/`moveObject`/`createConnection`/`deleteConnection` 成功后调用。**`setViewport` 不调**（视口不改桌面内容）
- `ArtifactService.deletePlaced` 与 `CanvasGenerateService.complete`（成功出图）成功后同样调用
- 组合根 `apps/server/src/index.ts`：实例化 cover service，向各 service 注册回调；`files.setReferenceCheckers` 增加 cover 引用检查（`projects.cover_file_id`)
- `listProjects()` 结果带 `coverFileId`(select * 已自动带，确认序列化字段名）

**Acceptance criteria:**
- [ ] 移动物件 / 增删连线 / 删物件 / 生图完成，均触发一次 schedule（单测或集成断言）
- [ ] 视口 PATCH 不触发
- [ ] `GET /api/projects` 返回项含 `coverFileId`
- [ ] 封面文件不被 `deleteUnattached` 扫描误删（checker 生效）

**Verification:**
- [ ] `npm test` 全绿；手测「上传图 → 等 ~8s → stored_files 出现 desk-cover.png」

**Dependencies:** Task 3

**Files likely touched:**
- `apps/server/src/services/desk-state-service.ts`
- `apps/server/src/services/artifact-service.ts`
- `apps/server/src/services/canvas-generate-service.ts`
- `apps/server/src/index.ts`
- `apps/server/src/services/project-cover-service.test.ts`（扩展）

---

## Task 5: Home.tsx 封面展示 + ProjectSummary 类型

**Description:** `src/lib/api.ts` 的 `ProjectSummary` 加 `coverFileId: string | null`。`Home.tsx`:`coverFileId` 存在时 `DeskPreview` 位置渲染 `<img src={api.fileUrl(coverFileId)}>`（样式已有 `.desk-thumb img`)；否则回退现有诚实空骨架。

**Acceptance criteria:**
- [ ] 有封面项目显示真实拼板图
- [ ] 无封面项目仍显示 CSS 骨架（不显示破图）
- [ ] 新建项目卡（`desk-thumb-new`）不受影响

**Verification:**
- [ ] `npm run build` 通过；手测 Home 列表两态

**Dependencies:** Task 4

**Files likely touched:**
- `src/lib/api.ts`
- `src/desk/Home.tsx`

---

## Task 6: minimap-geometry 纯函数 + 单测

**Description:** 新建 `src/desk/minimap-geometry.ts`:
- `worldBounds(objects)`：全桌包围盒 + padding（物件尺寸用 `nodeSize`)
- `minimapTransform(bounds, mapSize)`：世界 → minimap 像素的 `{scale, offsetX, offsetY}`
- `viewportRect(view, canvasSize, transform)`：可见世界区（`screenToWorld` 两角）→ minimap 里的 `{x, y, w, h}`
- `panByMapDelta(view, deltaMapPx, transform)`：拖视口框 → 新 viewport(zoom 不变）
- `centerOnMapPoint(view, mapPt, transform, canvasSize)`：点击 → 该世界点居中

**Acceptance criteria:**
- [ ] 空桌 bounds 有合理默认（不 NaN)
- [ ] zoom 翻倍时 viewportRect 宽高减半
- [ ] panByMapDelta 与手算一致（拖 10px map = 10/scale 世界像素）
- [ ] centerOnMapPoint 后目标点位于视口中心

**Verification:**
- [ ] `npx vitest run src/desk/minimap-geometry.test.ts` 通过

**Dependencies:** None（可与 Phase 1/2 并行）

**Files likely touched:**
- `src/desk/minimap-geometry.ts`（新建）
- `src/desk/minimap-geometry.test.ts`（新建）

---

## Task 7: Minimap 组件渲染 + 样式

**Description:** 新建 `src/desk/Minimap.tsx`：固定左下（~200×140)；物件缩略块（有图 `<img>` 用 `obj.url` + object-fit cover，无图 lifecycle 色块）；连线 SVG；视口框矩形。挂进 `Desk.tsx`（容器尺寸用 `vpRef` + ResizeObserver 得 canvasSize)。样式进 `styles/canvas.css`,DESIGN.md tokens。空桌隐藏。

**Acceptance criteria:**
- [ ] 物件位置比例与画布一致（视觉抽查 3 物件以上桌面）
- [ ] 平移/缩放画布时视口框实时正确跟随
- [ ] 空桌不渲染 minimap

**Verification:**
- [ ] `npm run build` 通过；手测

**Dependencies:** Task 6

**Files likely touched:**
- `src/desk/Minimap.tsx`（新建）
- `src/desk/Desk.tsx`
- `src/desk/styles/canvas.css`

---

## Task 8: minimap 拖拽交互

**Description:** Minimap 内：视口框 pointer capture 拖拽 → `panByMapDelta` 实时 `setView`；点非视口区域 → `centerOnMapPoint`。pointer 事件 `stopPropagation`，不触发画布自身的 pan/marquee。

**Acceptance criteria:**
- [ ] 拖视口框画布平滑跟随，松手位置正确
- [ ] 点击地图空白对应世界区居中（zoom 不变）
- [ ] 拖出 minimap 边界不丢 capture、不触发画布 marquee

**Verification:**
- [ ] 手测三种交互；`npm run build` 通过

**Dependencies:** Task 7

**Files likely touched:**
- `src/desk/Minimap.tsx`
- `src/desk/styles/canvas.css`

---

## Task 9: 全量验证 + agent 回归

**Description:** 按 spec Success Criteria 逐条验收：`npm test`、`npm run build`、`npm run build:server` 全绿；手测封面（出现/刷新/无图回退）与 minimap（跟随/拖拽/点击）;`look_at_desk` 相关测试原样全绿确认 agent 零回归。

**Acceptance criteria:**
- [ ] spec §Success Criteria 1–7 逐条打勾

**Verification:**
- [ ] 上述命令全绿 + 手测记录

**Dependencies:** Task 5, Task 8

**Files likely touched:** 无（仅验证；发现问题回到对应 Task)
