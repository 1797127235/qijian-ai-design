# 意图：人看的缩略图（项目封面 + 画布 minimap）

> 由 interview-me 流程确认（2026-08-08），用户已明确 yes。

## 确认的需求陈述

- **Outcome:** 两处「人看的缩略图」：① Home 项目列表的真实封面（替换现在的固定 CSS 骨架 `DeskPreview`）；② 画布左下角可拖拽 minimap（地图 + 视口框，拖动视口框画布跟随平移，Figma/Miro 式）
- **User:** 设计师本人——在列表里一眼分清项目；在画布里有空间导航感
- **Why now:** 封面现在是假图，所有项目长一样；agent 侧的 `desk-overview-renderer` 已存在，拼板逻辑可复用
- **Success:** 封面反映真实桌面内容；minimap 实时跟随视口、拖拽流畅（前端 60fps，不等 server）
- **Constraint:** 封面 server 预渲染防抖存库（复用 renderer，去 agent 装饰）；minimap 前端实时画
- **Out of scope:** 不改 agent 的 `desk_overview`（那是 Survey 视觉，独立存在）；minimap 不做缩放控制/对象级交互，只做平移导航

## 访谈中的关键决策

| 问题 | 决策 | 理由 |
|---|---|---|
| 缩略图出现在哪里 | 项目列表封面 + 画布内 minimap，两处都要 | 用户确认 |
| minimap 形态 | 左下角地图 + 视口框，可拖动视口框平移画布 | Figma/Miro 式成熟交互，用户曾体验过 |
| 渲染分侧 | 封面 server 预渲染 PNG 存库；minimap 前端实时画 | Home 页无桌面数据拿不到图片字节；minimap 拖拽要 60fps，server 出图跟不上 |
| 封面刷新时机 | 桌面实质变化后防抖（约 8s 空闲）重渲；Home 直接用缓存不现等 | 每次击键都渲太浪费；退出才渲会让长开项目封面永不更新 |
| 封面存储 | 派生缓存，可重算，丢了能重生 | 与 caption 缓存同语义 |

## 背景事实

- 现在 `Home.tsx` 的 `DeskPreview`（`src/desk/Home.tsx:24-33`）是纯 CSS 固定骨架，所有项目封面相同
- agent 侧已有 `renderDeskOverview`（`apps/server/src/services/desk-overview-renderer.ts`）：世界坐标 tiles → PNG，含 A01 角标/选中描边/连线
- 视口模型：`{x, y, zoom}`，`screenToWorld`/`zoomAtPoint`（`src/desk/geometry.ts`），stage 用 CSS `translate+scale`（`src/desk/Desk.tsx:385`）
- 项目列表 `GET /api/projects`；文件经 `GET /api/files/:id` 服务，前端 `api.fileUrl(fileId)`
