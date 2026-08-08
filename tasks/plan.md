# Implementation Plan: 画布图局部重绘（Canvas Inpainting）

## Overview

为画布上已出图的图片节点增加局部重绘：框选矩形区域 → 输入 prompt 和/或上传参考图 → AI 生成新效果图节点落在源右侧。Spec 见 `docs/canvas-inpainting-design.md`，意图见 `docs/intent/canvas-inpainting.md`。

## Architecture Decisions

- **区域语义靠裁图传递**：归一化 rect 发服务端，`@napi-rs/canvas` 按原图像素裁剪后作为唯一 ref 发给 grok edit（复用现有单 ref 通路，`image-generator.ts` 不动）
- **参考图与裁剪图服务端合成**：grok edit 只收单图 → 「裁剪区域 | 参考图」左右白底合成一张，prompt 说明左右含义
- **结果落点零新逻辑**：复用 `prepareNewTarget`（新 effect_image 落源右 + 连线 + pending/失败重试）
- **框选在节点本地坐标系**：选区层渲染在 obj 节点内部，天然跟随 zoom/pan/rot；提交前归一化
- **回归红线**：不带 `region` 的旧请求行为逐字节不变

## Task List

### Phase 1: 服务端基础

- [ ] Task 1: 图片裁剪/合成工具 `image-crop.ts` + 单测
- [ ] Task 2: generate-image 路由 + CanvasGenerateService 支持 region/referenceFileId + 单测

### Checkpoint: 服务端

- [ ] `npm test` 全绿（含新增），旧 generate 通路测试无回归
- [ ] 可用 curl 带 region 走通 generate-image（手动）

### Phase 2: 客户端通路

- [ ] Task 3: api 层 + useDeskGenerate 透传 region/referenceFileId
- [ ] Task 4: 框选交互（Desk 框选模式 + 节点选区渲染 + 坐标换算纯函数 + 单测）
- [ ] Task 5: InpaintPanel + 工具条「局部重绘」入口 + 提交接线 + 样式

### Checkpoint: 完成

- [ ] `npm run build && npm test` 全绿
- [ ] dev 环境手动走通 Spec 的 5 步交互流程 + 旧整图生成回归
- [ ] 评审后可交付

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| grok edit 对合成图（左区域右参考）理解不稳定 | Med | prompt 明确左右语义；失败时可只发裁剪图 + 文字兜底；v1 接受质量波动（已确认） |
| 框选坐标在旋转节点上算错 | Med | 纯函数单测覆盖 rot≠0 的换算；选区层放在节点内部天然对齐 |
| 裁剪掉整图源后生成质量下降（上下文变少） | Med | prompt 前缀注明局部修改语义；region 记 payload 可回溯调整 |
| napi-rs 处理超大原图内存 | Low | 现有 MAX_IMAGE_BYTES 20MB 上限已兜底；裁剪失败走 `publicGenerateError` 口径 |

## Open Questions

- 无
