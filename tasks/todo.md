# Tasks: 画布图局部重绘

## Task 1: 图片裁剪/合成工具 image-crop.ts + 单测

**Description:** 新建 `apps/server/src/services/image-crop.ts`，基于 `@napi-rs/canvas`（项目已有依赖，agent-image-loader.ts 在用）实现两个纯函数：`cropImage(bytes, mediaType, region)` 按归一化 rect 裁剪并输出 PNG bytes；`composeSideBySide(a, b)` 把两张图等高、16px 白底间隔左右合成 PNG。输入做 magic bytes 校验（复用 image-generator 的签名思路），region 越界 clamp 到图内。

**Acceptance criteria:**
- [ ] cropImage 输出尺寸 = round(region * 原图 dims)，边界 clamp 不出图
- [ ] region 全 0/负值/超出 1 时抛错或 clamp（按设计：w/h < 0.02 抛 HttpError 422 语义错误）
- [ ] composeSideBySide 输出宽度 = a.w + b.w + 间隔，高度 = 两者较大值，白底
- [ ] 非图片 bytes 输入报错

**Verification:**
- [ ] `npx vitest run apps/server/src/services/image-crop.test.ts` 通过

**Dependencies:** None

**Files likely touched:**
- `apps/server/src/services/image-crop.ts`（新建）
- `apps/server/src/services/image-crop.test.ts`（新建）

**Estimated scope:** S

---

## Task 2: generate-image 支持 region / referenceFileId + 单测

**Description:** 路由 `desk.ts` body schema 增加可选 `region {x,y,w,h∈[0,1], w/h≥0.02}` 与 `referenceFileId`（uuid）；`GenerateFromCanvasInput` 同步扩展。prepare：region 写入 pending payload（`{ region, inpaint: true }`）供重试/审计。complete：调 `images.generate` 前——有 region 则裁剪源图替换参考列表中的整图源；有 referenceFileId 且有 region 则合成；只有 referenceFileId 则其作为唯一 ref。composedPrompt 前缀局部修改语义。referenceFileId 跨项目/非图片 → 422。

**Acceptance criteria:**
- [ ] 不带 region/referenceFileId 的请求行为与现状完全一致（回归）
- [ ] mock ImageGenerator 断言：带 region 时收到的 referenceFiles[0] 是裁剪结果而非整图
- [ ] region 写进 pending artifact payload；终态 payload 保留 region
- [ ] region 越界（w<0.02、值域外）→ 422；referenceFileId 不属于本项目 → 422

**Verification:**
- [ ] `npm test` 全绿（新增 + 回归）
- [ ] curl 带 region 调通（手动，dev:server）

**Dependencies:** Task 1

**Files likely touched:**
- `apps/server/src/http/routes/desk.ts`
- `apps/server/src/services/canvas-generate-service.ts`
- `apps/server/src/services/canvas-generate-service.test.ts`（或就近新增测试文件）

**Estimated scope:** M

---

## Checkpoint: 服务端

- [ ] `npm test` 全绿，旧通路无回归
- [ ] curl 手动验证带 region 的 generate-image

---

## Task 3: api 层 + useDeskGenerate 透传 region/referenceFileId

**Description:** `src/lib/api/http.ts` 的 `generateImage` input 类型加 `region?` / `referenceFileId?` 并透传；`useDeskGenerate.ts` 的 `GenerateOptions` 加对应可选字段，调用 `api.generateImage` 时带上。无行为变化，纯类型与透传。

**Acceptance criteria:**
- [ ] `gen.generate({ ..., region, referenceFileId })` 能到达请求 body（不丢字段）
- [ ] 不传时 body 与现状一致

**Verification:**
- [ ] `npm run build` 通过
- [ ] `npm test` 全绿

**Dependencies:** Task 2（契约已定）

**Files likely touched:**
- `src/lib/api/http.ts`
- `src/app/useDeskGenerate.ts`

**Estimated scope:** S

---

## Task 4: 框选交互 + 坐标换算 + 单测

**Description:** `Desk.tsx` 增加框选模式：props 新增 `inpaintTargetId?` / `onInpaintRegion(objectId, rect)` / `onInpaintCancel`。目标 obj 节点内部渲染选区层：pointerdown 起拖、pointermove 更新、pointerup 提交（松手 <2% 面积视为取消）；节点本地坐标（screenToWorld → 减节点原点 → 反向 rot → 除以显示尺寸归一化）。`nodes.tsx` 图片节点在框选模式下渲染半透明 dim 遮罩 + accent 选区框。坐标换算抽纯函数到 `src/desk/inpaint-geometry.ts` 并单测（含 rot≠0）。

**Acceptance criteria:**
- [ ] 拖出矩形松手后回调收到归一化 rect，值域 [0,1]
- [ ] rot=45° 节点上框选换算正确（单测）
- [ ] 选区 <2% 面积松手无回调（视为取消）；Esc 取消
- [ ] 框选期间不触发节点拖拽/画布平移（事件 stopPropagation）

**Verification:**
- [ ] `npx vitest run src/desk/inpaint-geometry.test.ts` 通过
- [ ] `npm run build` 通过

**Dependencies:** None（与 Task 1-3 可并行）

**Files likely touched:**
- `src/desk/inpaint-geometry.ts`（新建）+ 测试
- `src/desk/Desk.tsx`
- `src/desk/nodes.tsx`
- `src/desk/desk.css`

**Estimated scope:** M

---

## Task 5: InpaintPanel + 工具条入口 + 提交接线

**Description:** 新组件 `src/desk/InpaintPanel.tsx`：复用 `desk-prompt-panel` 样式，含 textarea、参考图上传按钮（`validateCanvasImageFile` + `api.uploadFile`，缩略 chip 可移除）、提交/取消。`App.tsx`：`renderNodeToolbar` 对带图节点加「局部重绘」按钮 → 进入框选模式；拿到 rect 后在选区旁挂 InpaintPanel；提交走 `gen.generate({ sourceArtifactId, prompt, region, referenceFileId })`；prompt 与参考图均空时禁用提交。面板样式补 desk.css（复用 token，符合 DESIGN.md 动效约定）。

**Acceptance criteria:**
- [ ] 完整走通 Spec 5 步交互：选中 → 按钮 → 框选 → 面板 → 生成 → 源右侧 pending 新卡
- [ ] prompt/参考图均空时提交禁用；生成中 busy 态
- [ ] Esc 逐级退出（面板 → 框选模式）
- [ ] 失败卡可重试（复用现有重试通路，targetArtifactId 带上 region）

**Verification:**
- [ ] `npm run build && npm test` 全绿
- [ ] dev 环境手动验收 5 步流程 + 旧整图生成回归 + 显影/退场动效无破坏

**Dependencies:** Task 3, Task 4

**Files likely touched:**
- `src/desk/InpaintPanel.tsx`（新建）
- `src/app/App.tsx`
- `src/desk/desk.css`

**Estimated scope:** M

---

## Checkpoint: 完成

- [ ] `npm run build && npm test` 全绿
- [ ] 手动走通 5 步流程 + 旧通路回归
- [ ] 对照 `docs/canvas-inpainting-design.md` Success Criteria 逐条核对
