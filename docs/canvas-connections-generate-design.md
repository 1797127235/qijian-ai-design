# 画布连线 + 面板生图设计

> 状态：APPROVED（brainstorming 2026-08-06，三项建筑学长参考功能经用户确认全部进 TODOS）
> 参考：`/media/liu/Data/开源仓库/infinite-canvas`（连线模型与交互）、建筑学长画布（浮动操作条/图片加工/查看对比，本期不做）

## 范围

本期只做两件事：

1. **连线**：物件之间的有向连线，语义 = 生图参考输入。
2. **面板生图**：选中物件 → 物件下方提示词面板 → 直连服务端生成 → 图落右侧并自动连线。

明确不做（已进 TODOS）：选中浮动操作条（重新生成/大图/下载）、图片加工（局部重绘/细节增强/视角转换/宫格拆分）、原图 vs 生成图滑块对比、涂鸦/框选。

## 已定决策（用户确认）

- 连线语义 = 生图参考输入（连入的参考图/文字自动成为生成上下文）
- 生图入口 = 物件下方提示词面板（非底栏按钮、非右键菜单）
- 图像服务支持参考图改图接口，直接做
- 连线创建 = 从物件把手拖出（infinite-canvas 形态）
- 生图执行 = 新直连端点，不走聊天 agent（不污染对话、等待更短）

## 数据模型

### 连线（服务端持久化）

`deskState` 增加 `connections` 数组：

```ts
{ id: string; from: string; to: string }  // from=参考源物件(artifactId)，to=生成目标物件(artifactId)
```

- 随 desk snapshot 下发；新增 `POST /api/projects/:id/desk/connections`、`DELETE .../connections/:id`。
- 约束（服务端校验，参考 `normalizeConnection`）：禁止自连、禁止重复（同 from+to 幂等返回已有）；from/to 必须存在于 desk objects。
- 删除物件时级联删除其所有连线（同事务）。
- 连线纳入会话内撤销：`place_connection` / `remove_connection` 两种历史 op（逆操作互逆，复用 useDeskHistory 模式）。

### 生图 artifact（`effect_image`，与 `canvas_image` 分离）

- 白名单重新引入 `effect_image`（与 `sticky_note` / `canvas_image` 并列）。
- **生成开始**：`createPlaced(effect_image, status=draft, payload: { pending: true, prompt, source: "canvas_panel" })`，**允许无 file_id**；layout 在源物件右侧（`x = source.x + 220 + 60`，同 y）；自动补一条 源→新图 连线（同事务）。
- **生成成功**：`appendVersion` 填 `{ file_id, prompt, source: "canvas_panel", pending: false }`，status→confirmed；inputRefs = 参考图 file_ids + 连线源 artifact_ids。
- **生成失败**：payload 加 `{ error: string, pending: false }`，status 保持 draft；卡片可右键删除 / 重试。
- 前端 `map.ts`：`effect_image` 有 file_id → 渲染图；pending → 「生成中」骨架；error → 错误态 + 重试。

## 交互

### 连线（参考 infinite-canvas canvas-connections.tsx）

- 物件 hover/选中时显示两个把手点：右缘=source，左缘=target。
- 从把手 pointerdown 拖出：虚线贝塞尔跟随鼠标，hover 到合法目标时吸附其左缘锚点；松手落点合法 → 创建连线；落空白 → 取消（不做参考库的 PendingConnectionCreate 菜单）。
- 已存在连线：SVG 三次贝塞尔（曲率 `max(|dx|*0.5, 50)`），2px 描边，选中 3px；16px 透明命中路径；右键连线弹「删除连线」菜单（复用 desk-context-menu）。
- 手势只认左键；连线层在物件层之下（z 序：connections SVG < objects）。
- 把手拖拽手势不触发物件拖动与画布平移（复用 button-guard 思路，把手 stopPropagation）。

### 提示词面板

- 选中图片/便签/效果图物件 → 物件下缘浮出面板：
  - 提示词 textarea（Enter 提交 / Esc 关闭）
  - 参考 chips：已连入本物件的连线源缩略图/文本（只读，提示「拖线可添加参考」）
  - 生成按钮（无 prompt 且便签无文本时禁用）
- 生成中：目标位置先出 loading 占位卡（骨架动画），面板按钮变「停止」（AbortController）。
- 成功：效果图落在源物件右侧，自动连线，面板关闭。
- 失败：占位卡变错误态（错误信息 + 重试按钮）；占位卡可右键删除。
- 面板打开期间物件被删除/取消选中 → 面板关闭。

## 服务端改动

### generate 端点

`POST /api/projects/:id/generate-image`

```ts
{ prompt: string; sourceArtifactId: string; clientOpId: string }
```

流程（单请求、可中断）：

1. 幂等查 clientOpId；已有则直接返回。
2. 解析参考：`sourceArtifactId` 自身若为 canvas_image/effect_image 且有 file_id → 加入参考；其**连入**连线的 from 物件：图取 file_id、便签取 text。
3. **同事务** createPlaced draft effect_image + 源→新图 connection → 返回 `{ artifact, connection }`（前端立刻显示「生成中」）。
4. 异步/同请求续跑：`ImageGenerator.generate` 扩展 `referenceFiles`；有参考走 provider 改图接口，无参考走纯文本；超时 120s，AbortSignal 透传。
5. 成功 appendVersion 填 file_id；失败写 error 到 payload。
6. prompt 合成：用户 prompt + 连线便签文本（前缀「参考要求：」）；参考 file 读失败则跳过并在 prompt 末附「（有参考图缺失）」。

**队列**：generate **不进** desk enqueue（避免堵移动/删除/连线）；按 sourceArtifactId 互斥 in-flight Map；完成后用 enqueue 做一次 refreshDesk。

### connections 持久化

- desk_state schema：`objects` 同级 `connections` JSONB（默认 `[]`）。
- `POST /desk/connections`：`{ from, to, clientOpId }` → 校验 + 插入（幂等）。
- `DELETE /desk/connections/:id` → 删除。
- deleteObject / deletePlaced 级联删除相关 connections（同事务）。

## 前端改动

- `src/desk/types.ts`：`DeskConnection`；`src/desk/map.ts`：映射 snapshot.connections。
- `src/desk/Connections.tsx`：SVG 贝塞尔层 + 拖拽预览线。
- `src/desk/Desk.tsx`：把手点渲染、连线手势状态机（connectingRef）、connections 层挂载。
- `src/desk/PromptPanel.tsx`：面板组件。
- `src/app/useDeskGenerate.ts`：generate 编排（loading 占位 optimistic、abort、错误/重试），复用 enqueue 串行队列 + history。
- `src/app/App.tsx`：接线。
- 会话历史新增 op：`place_connection`/`remove_connection`/`generate`（generate 的 undo = 删图+删线，redo = 同 UUID 重插；`DeskHistoryEntry.artifactType` 扩到 `effect_image`）。
- 右键菜单：物件 → 删除；连线 → 删除连线。

## 错误处理

- provider 5xx/超时 → 占位卡错误态 + chat 区错误提示（复用 pushCanvasError）。
- 参考 file 读取失败（GC/孤儿）→ 跳过该参考并继续，prompt 末尾附「（有参考图缺失）」提示。
- 连线端点校验失败（自连/重复/物件不存在）→ 409/400，前端静默取消拖拽。

## 测试

- vitest 纯函数：连线 normalize（自连/重复/级联）、贝塞尔锚点几何、历史 op 逆操作、prompt 合成。
- pg 集成：connections CRUD + 幂等 + 级联删除；generate 端点（mock provider，断言参考 file 进入 multipart、artifact+connection 同事务落库）。
- renderToStaticMarkup：PromptPanel、Connections 层。
- 用户流走 `/qa`：拖把手连线→刷新仍在；面板生图→图落右侧自动连线→刷新保持；删物件级联删线；undo/redo 连线与生成；右键删线。

## 键盘/手势守卫

- 面板 textarea 内 Delete/Ctrl+Z 不触发画布操作（复用 isEditableTarget）。
- 连线拖拽中 Ctrl+Z 忽略（历史栈 applying/drag 守卫已有模式）。

---

## Eng Review 定案（2026-08-06）

| # | 决策 | 选择 |
|---|------|------|
| D1 | 生成中占位 | draft artifact 落库（刷新仍在） |
| D2 | 长请求与队列 | generate 不进 desk enqueue，独立 in-flight |
| D3 | 参考图范围 | 源物件自身图 + 连入参考 |
| D4 | 生成图类型 | 重引 `effect_image`（与 canvas_image 分离） |
| D5 | 连线存储 | `desk_state.connections` JSONB 列，default `[]` |

方向对齐 infinite-canvas：把手拖连、贝塞尔连线、源→生成自动连线、edit 模式自身作参考、loading 节点落盘。

## Implementation Tasks

- **T1 schema**：drizzle 0013 加 `desk_state.connections jsonb default []`；`artifactTypes` 加 `effect_image`；`assertPayload` 对 effect_image：pending 时允许无 file_id，非 pending 必须 file_id。
- **T2 domain/types + snapshot**：`DeskSnapshot.deskState.connections`；desk-state-service 读写 connections。
- **T3 connections API**：`POST/DELETE .../desk/connections`；normalize（自连/重复/物件存在）；deletePlaced 级联删线；clientOpId 幂等。
- **T4 ImageGenerator**：扩展 `referenceFiles`；有参考走 edits 接口，无参考走现路径；归档仍走 FileStorage（ARCHIVE_GENERATED_IMAGES）。
- **T5 generate 端点**：`POST .../generate-image`；draft 占位 + 连线同事务；续跑 appendVersion / 写 error；AbortSignal。
- **T6 前端 map/types/nodes**：DeskConnection；effect_image 三态渲染（pending/error/image）；canvas_image 不变。
- **T7 Connections.tsx + Desk 把手手势**：SVG 贝塞尔、拖预览、右键删线、stopPropagation。
- **T8 PromptPanel + useDeskGenerate**：面板 UI；in-flight Map；abort；history `generate` op。
- **T9 useDeskHistory**：`place_connection`/`remove_connection`/`generate`；entry 支持 effect_image。
- **T10 测试**：vitest normalize/几何/history；pg connections+generate mock；renderToStaticMarkup 面板/连线层。
- **T11 QA**：按测试计划 critical paths 手测。

## GSTACK REVIEW REPORT

- **Reviewed:** docs/canvas-connections-generate-design.md
- **Decisions locked:** D1–D5
- **Status:** CLEAR — ready for implementation
- **Outside voice:** deferred (user chose infinite-canvas alignment)
- **Date:** 2026-08-06
