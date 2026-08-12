# Spec: 画布图局部重绘（Canvas Inpainting）

> 意图来源：`docs/intent/canvas-inpainting.md`（interview-me 已确认）
> 状态：待评审

## Objective

画布上已出图的图片节点（`canvas_image` / `effect_image`，有 `url`）支持局部重绘：用户框选图上一块矩形区域，输入文字 prompt 和/或上传一张参考图，AI 生成一张只针对该区域修改的新效果图，作为新节点落在源图右侧（原图保留，连线可追溯）。

**用户：** 家装设计师，提案阶段快速替换效果图中某个元素（沙发、墙面、窗景）。
**不做：** 涂抹 mask、真 mask inpainting（框外像素级不变）、一次多区域、版本管理。

## 交互流程

1. 选中带图节点 → `desk-node-toolbar` 出现「局部重绘」按钮（无图/便签/生成中节点不显示）
2. 点击 → 弹出居中重绘弹窗（`InpaintDialog`）：大图等比展示（max 56vh），在大图上拖拽画出矩形选区（图片显示坐标归一化，无需 rot/世界坐标换算）；可重复拖拽重画；Esc 或点击遮罩取消
3. 弹窗内同卡片集成重绘面板（复用 `desk-prompt-panel` 样式语言）：
   - textarea：描述要怎么改（placeholder: "这块要变成什么样？如：换成深绿色丝绒沙发…"）
   - 参考图上传按钮（复用附件校验与上传通路），已上传显示缩略 chip 可移除
   - Enter / 「重绘」提交；Esc 关闭弹窗
4. 提交 → 弹窗关闭，走现有 generate-image 异步通路：pending 卡立刻落源右侧 → 终态回填；失败红色卡片可重试
5. 未框选选区，或 prompt 与参考图均为空时，提交按钮禁用

## 技术方案

### 请求/响应

`POST /api/projects/:id/generate-image` body 扩展（全部可选，缺省即现有整图生成）：

```ts
{
  prompt: string;
  sourceArtifactId: string;
  clientOpId: string;
  targetArtifactId?: string;         // 重试
  region?: { x: number; y: number; w: number; h: number };  // 归一化 0–1，源图本地坐标
  referenceFileId?: string;          // 用户上传的参考图（附件通路 fileId）
}
```

校验：`region` 四值 ∈ [0,1]，w/h ≥ 0.02（小于 2% 的选区视为误触，422）；`referenceFileId` 必须是本项目 stored_files 里的图片。

### 服务端

- `canvas-generate-service.ts`：`GenerateFromCanvasInput` 增加 `region?` / `referenceFileId?`；prepare 原样落 pending（region 记入 payload 便于重试/审计），complete 在调 `images.generate` 前处理参考文件：
  - 有 `region`：加载源图 bytes → 裁剪为新 `ReferenceFile` 替换掉参考列表里的整图源
  - 有 `referenceFileId` 且有 `region`：把「裁剪图 | 参考图」左右合成一张（白底 16px 间隔），作为唯一 ref；prompt 追加约定语句（"左图是要修改的区域，参考右图提供的物品/风格进行替换"）
  - 有 `referenceFileId` 无 `region`：参考图作为唯一 ref（现有行为一致）
- 新文件 `apps/server/src/services/image-crop.ts`：基于 `@napi-rs/canvas` 的 `cropImage(bytes, mediaType, region)` 与 `composeSideBySide(a, b)`；输入输出都做 magic bytes 校验，输出 PNG
- `image-generator.ts`：不动（单 ref 限制在 service 层消化）
- 生成的 composedPrompt 前缀注明局部修改语义（如「只修改图片中所给区域，其余保持」），region 记入 artifact payload：`{ region, inpaint: true }`

### 客户端

- `InpaintDialog.tsx`：弹窗一体化组件——大图上 pointer 拖拽框选（`setPointerCapture`，容器局部坐标），`normalizeRect` 归一化；同卡片内含 prompt textarea 与参考图上传（复用 `attachments.ts` 校验 + api 上传）；Esc/遮罩/取消关闭
- `App.tsx`：`inpaintSourceId` 状态控制弹窗开关；`Desk` 不再感知重绘框选（画布框选层已移除）
- `src/lib/api.ts` + `useDeskGenerate`：generate 入参透传 `region` / `referenceFileId`
- 工具条：`Desk` 的 `renderNodeToolbar` 回调处（App.tsx）对带图节点追加「局部重绘」按钮

### 坐标约定

- 选区在**弹窗大图显示坐标**记录，提交前除以图片显示宽高归一化（节点显示宽高与原图宽高比一致，归一化结果与显示尺寸无关）
- 服务端按源图实际像素 `round(region * dims)` 裁剪

## Commands

```
Build: npm run build
Test:  npm test
Dev:   npm run dev（前端）+ npm run dev:server（服务端）
```

## Testing Strategy

- **服务端单测**（vitest，`*.test.ts` 同目录）：
  - `image-crop.test.ts`：裁剪尺寸/边界 clamp/合成尺寸；非法 region、非图片输入报错
  - `canvas-generate-service` 相关：带 region 的 prepare 把 region 写进 payload；complete 调用 images.generate 时参考图为裁剪结果（mock ImageGenerator 断言）
  - 路由层：region 越界 → 422；referenceFileId 跨项目 → 422
- **客户端**：纯函数坐标换算（screen→local、归一化）单测；交互走手动验证
- **手动验收**：dev 起服务，真实走一遍 5 步交互流程

## Boundaries

- **Always:** 改服务端逻辑配 vitest 单测；错误文案走 `publicGenerateError` 口径；提交前 `npm run build && npm test` 全绿
- **Ask first:** 新增依赖、改 DB schema、动 `image-generator.ts` 的请求契约
- **Never:** 把 mask/像素级保真做进 v1；破坏现有整图生成通路（不带 region 的请求行为必须逐字节不变）

## Success Criteria

1. 选中带图节点 → 工具条有「局部重绘」→ 弹窗大图拖出矩形 → 弹窗内提交 prompt 和/或参考图 → 源图右侧出现 pending 新节点 → 回填成图，且修改集中在框选区域附近
2. 不带 `region` 的旧请求行为完全不变（回归）
3. 框选 < 2% 面积无法提交；Esc 全程可退出
4. 生成失败显示红色失败卡，可原地重试
5. `npm run build && npm test` 全绿，含新增服务端单测

## Open Questions

- 无（若评审对假设 4 的合成图方案有疑虑，备选：只发裁剪图、参考图内容靠设计师写进 prompt——质量更差，不推荐）
