# Spec: 人看的缩略图（项目封面 + 画布 Minimap)

**状态：** 待评审
**日期：** 2026-08-08
**意图：** [docs/intent/human-thumbnails.md](intent/human-thumbnails.md)
**相关：** [agent-desk-world-model-fields.md](agent-desk-world-model-fields.md)（派生缓存语义）、`desk-overview-renderer.ts`（复用拼板）

---

## Objective

为人（设计师）提供两处真实缩略图，与 agent 的 `desk_overview` 完全独立：

1. **项目封面（Home 列表）**：server 预渲染的桌面拼板 PNG，替换 `Home.tsx` 里所有项目共用的固定 CSS 骨架 `DeskPreview`。
2. **画布 Minimap**：左下角小地图 + 视口框，实时跟随平移缩放；拖动视口框或点击地图可平移画布（Figma/Miro 式）。

成功标准见文末 Success Criteria。

**明确不做：** 改动 agent `look_at_desk` / `desk_overview` 的任何行为；minimap 的缩放控制与对象级交互；封面的手动上传/替换。

---

## Tech Stack

- Server: Hono + drizzle(PostgreSQL) + `@napi-rs/canvas`（已用于 agent 总览）
- Frontend: React 18 + CSS transform 视口模型（`src/desk/geometry.ts`）
- 测试： vitest（前后端同仓，`npm test`）
- **无新增依赖**

---

## Commands

```bash
Dev (前端):        npm run dev
Dev (server):      npm run dev:server
Test:              npm test
Build (前端):      npm run build
Build (server):    npm run build:server
DB migration 生成: npm run db:generate
DB migrate:        npm run db:migrate
```

---

## Project Structure（本特性涉及）

```
apps/server/src/services/
  desk-overview-renderer.ts      → 既有；新增人看风格渲染入口（或变体参数）
  project-cover-service.ts       → 新增：封面调度（防抖）+ 渲染 + 存取
  project-cover-service.test.ts  → 新增
apps/server/src/http/routes/
  projects.ts                    → listProjects 返回 coverFileId
  desk.ts                        → 桌面变更后触发 scheduleCoverRender
apps/server/drizzle/
  0018_project_cover.sql         → 新增 migration（projects 加列）
src/desk/
  Minimap.tsx                    → 新增：小地图组件
  minimap-geometry.ts            → 新增：world↔minimap 换算（纯函数，可测）
  minimap-geometry.test.ts       → 新增
  Desk.tsx                       → 挂载 Minimap，传入 view/objects/connections
  Home.tsx                       → DeskPreview 换成封面 <img>（无封面回退骨架）
  styles/canvas.css / home.css   → minimap / 封面样式
docs/intent/human-thumbnails.md  → 已确认意图
```

---

## 设计

### A. 项目封面（server 预渲染）

**渲染：** 复用 `renderDeskOverview` 的拼板逻辑（pose 排布、点阵背景、圆角卡片、缩略图、连线），但出人看风格变体：

- **去掉** A01 alias 角标与选中高亮描边（agent 专用装饰）
- 保留连线（血缘对人也有意义），样式可更淡
- 生命周期灰块语义保留（pending/failed/empty 可辨识）
- 输出 PNG，边长可沿用 1024（前端 `object-fit: cover` 缩放）

实现形态二选一（实现时定，倾向 ①）：
① `renderDeskOverview` 加 `style: "agent" | "human"` 参数，默认 `"agent"` 不改现状；
② 拆出共享布局内核 + 两个装饰层。倾向 ① 因为 diff 最小。

**存储（派生缓存，可重算）：**

- `projects` 表加两列：`cover_file_id uuid → stored_files.id`（nullable）、`cover_revision text`（nullable，记录渲染依据，避免重复渲染）
- 封面 PNG 写入 `stored_files`（与普通文件同生命周期，删项目级联清）
- `GET /api/projects` 的 ProjectSummary 增加 `coverFileId: string | null`；前端用 `api.fileUrl(coverFileId)` 取图
- `coverFileId = null` → 前端回退现有诚实空骨架，不假装有图

**刷新调度：** `project-cover-service` 内存防抖（默认 8s）：

- 触发点：桌面实质变化——`PATCH /desk`、`PATCH /desk/objects/:id`、`DELETE /desk/objects/:id`、connections 增删、artifact 新建/版本就绪（生图完成）
- 防抖窗口内多次变化只渲一次；渲染失败静默记日志，保留旧封面
- 与 `revisionOf(snapshot)` 对比 `cover_revision`，相同则跳过
- 不引入 job 表/队列；进程重启丢了调度无所谓（下次变化会再触发）

### B. 画布 Minimap（前端实时）

**组件：** `src/desk/Minimap.tsx`，挂载于 `Desk.tsx`（左下角固定 overlay，约 200×140）。

**渲染：** DOM 缩放（不用 canvas）：一个 `minimap-stage` 容器按 `k = minimapFit / worldBounds` 缩放，内部每个物件一个缩略块（有图 `<img>` 用 `api.fileUrl` + `object-fit: cover`，与画布节点同源所以走浏览器缓存；无图按 lifecycle 色块），连线用 SVG 线段，视口框一个绝对定位矩形。`view` 变化只是改视口框的 left/top/width/height，60fps 无压力。

**几何（纯函数，进 `minimap-geometry.ts`）：**

```
worldBounds(objects)        → 全桌包围盒 + padding
minimapTransform(bounds)    → { scale, offsetX, offsetY }（世界 → minimap 像素）
viewportRect(view, canvasSize, transform)
                            → 视口框在 minimap 里的 {x, y, w, h}
                            （可见世界区 = screenToWorld 四角；复用 geometry.ts）
panToMinimapPoint(point, transform, view, canvasSize)
                            → 点击/拖拽映射回新 viewport {x, y}（zoom 不变）
```

**交互：**

- 拖视口框：pointer capture，按 minimap 像素位移 ÷ scale 换算世界位移，实时 `setView`（zoom 不变）
- 点地图非视口区域：把该点对应的世界点居中
- 不做：缩放、框选、对象点击、连线编辑

**世界为空时：** minimap 隐藏（或显示「空桌面」占位——实现时按 DESIGN.md 调）。

---

## Code Style

跟随现有代码：TS strict、中文注释解释「为什么」、服务层依赖注入（参考 `desk-overview-renderer.ts` 的纯函数 + `look-at-desk.ts` 的读盘分离）、纯函数几何可测（参考 `geometry.ts` / `map.ts`）。组件样式进 `styles/canvas.css` / `home.css`，用 DESIGN.md tokens。

---

## Testing Strategy

- `minimap-geometry.test.ts`：bounds/transform/viewportRect/panToMinimapPoint 的纯函数单测（对齐 `geometry.test.ts` 风格）
- `project-cover-service.test.ts`：防抖合并、revision 相同跳过、渲染失败保留旧封面（注入假 renderer + 假时钟）
- 渲染变体：扩展现有 `desk-overview-renderer.test.ts`，断言 human 风格无 alias 角标
- Home/Minimap 组件层：手测为主（视觉件）；几何与调度逻辑必须进单测
- 验证命令：`npm test`、`npm run build`、`npm run build:server`

---

## Boundaries

- **Always:** 改完跑 `npm test`；几何逻辑写成纯函数；agent 渲染路径零行为变化（现有测试必须全绿）
- **Ask first:** DB schema 变更（`projects` 加列 + migration 0018）——本 spec 已包含此提案，评审即确认；新增依赖（本设计不需要）
- **Never:** 让封面渲染阻塞任何 API 响应；把 agent `desk_overview` 与人看封面合并成同一张图；在 minimap 里加缩放/对象交互

---

## Success Criteria

1. Home 列表里，有 ready 图片的项目显示反映真实桌面布局的封面；无图项目显示诚实空骨架
2. 桌面变化约 8s 空闲后封面自动更新；`/api/projects` 响应时间不因封面退化（渲染全异步）
3. Minimap 实时跟随平移/缩放，视口框位置尺寸正确（zoom 变化时框反比缩小）
4. 拖 minimap 视口框，画布平滑跟随；松手后位置正确
5. 点击 minimap 空白处，对应世界区域居中（zoom 不变）
6. agent 的 `look_at_desk` 工具行为与输出格式完全不变（现有测试全绿）
7. `npm test`、`npm run build`、`npm run build:server` 全绿

---

## Open Questions

1. **DB migration 确认**：`projects` 加 `cover_file_id` + `cover_revision` 两列，生成 `0018_*.sql`——同意？
2. Minimap 默认固定显示还是可折叠（折叠态记忆 localStorage）？倾向：固定显示，先不做折叠。
3. 封面连线是否保留？倾向：保留但淡化（血缘对人有辨识度价值）。
