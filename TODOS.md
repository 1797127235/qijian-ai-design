# TODOS

## 1. 服务端操作历史（跨刷新撤销/重做）

- **What:** `desk_operations` 表（id/project_id/sequence/type/payload/inverse/created_at/created_by）+ `desk_state.history_head` 指针 + `POST /api/projects/:id/desk/undo|redo` + GET desk 带 canUndo/canRedo；place/move/remove/update_text 同一事务写 log；cap 100-200 条；remove 改 tombstone（artifacts.deleted_at）。
- **Why:** Agent 桌面 tools 落地后需要与人工共用同一历史模型；跨刷新撤销是原产品承诺（office-hours Approach B，2026-08-06 eng review D3 降级为会话内，决策见 gstack decision log）。
- **Pros:** 刷新/崩溃后误操作可恢复；Agent 写桌可直接复用；undoable 事件字段已预留。
- **Cons:** 工期 L；需处理日志与版本链边界、cap 截断窗口与 canUndo 计算。
- **Context:** 设计全文见 `docs/canvas-toolbar-history-design.md` 修订前版本（git 历史）及 `~/.gstack/projects/1797127235-qijian-ai-design/liu-codex-canvas-reliability-design-20260806-111110.md`。删除语义当时定的是 tombstone（D2 分析：日志快照方案会导致文件 409 保护失效）。启动时机：Agent 桌面 tools 切片。
- **Depends on / blocked by:** Agent 写桌需求出现前不做。

## 2. 孤儿上传文件 GC

- **What:** 定期（或手动触发）清理不被任何 artifact（payload.file_id / input_refs）或聊天消息引用的 `stored_files` 行 + 磁盘字节。
- **Why:** 上传成功但 createPlaced 失败/放弃、物件被删除后，文件成孤儿永久残留（eng review T3 + codex 指出）。
- **Pros:** 存储有界；与 HISTORY-aware 思路一致（参考 infinite-canvas `cleanupUnusedImages`）。
- **Cons:** 必须排除「会话内仍可撤销」的引用窗口——会话内撤销重建依赖同 file_id，GC 窗口必须大于会话生命周期或按项目活跃度保守估计。
- **Context:** 检查器模式已存在（`FileReferenceChecker`，`artifact-service.ts:96`）。删除物件（硬删 artifact）后引用消失，文件立即可被 DELETE API 删掉——目前无 UI 触发，GC 需自行识别。
- **Depends on / blocked by:** 无；但若先做 TODO 1（tombstone），GC 需同步排除墓碑引用。

## 3. 跨标签页 desk 同步（WS 广播）

- **What:** desk 的 HTTP 变更（createPlaced / moveObject / deleteObject）广播 `object_changed` WS 事件；前端收到后 refetch desk snapshot。
- **Why:** 目前只有 Agent tools 路径发事件，HTTP 路径不发；多 tab 同开一项目会互相陈旧直到手动刷新。
- **Pros:** 事件通道、`undoable` 字段、前端 refetch 逻辑全部现成，接线即可。
- **Cons:** 需处理 refetch 与本地乐观更新的竞态（stale refresh 守卫，本切片已要求串行化 desk 变更，可复用同一守卫）。
- **Context:** `apps/server/src/agent/events.ts:15`、`src/app/useChatSession.ts:150-157`。本切片 eng review Section 1 Issue 5 降为 TODO。
- **Depends on / blocked by:** 无。

## 4. PDF 画布预览

- **What:** 画布图片入口支持 PDF：整文件引用 + pdf.js 渲染首页预览（或文件卡片点击预览）。
- **Why:** 设计师上传户型图 PDF 是真实高频路径；第一期画布仅 JPEG/PNG（eng review D5）会在真实工作流里咬人。
- **Pros:** `pdfjs-dist@6.2.108` 已在 dependencies、`@napi-rs/canvas` 服务端渲染能力也在，实际成本低于最初估计。
- **Cons:** worker 配置、渲染失败兜底、大 PDF 性能需处理。
- **Context:** D5 决策记录（gstack decision log）。上传管线 `inspectUpload` 已提取 pageCount。
- **Depends on / blocked by:** 无。

## 5. 选中物件浮动操作条

- **What:** 选中图片/效果图物件时浮出操作条：提示词（面板入口）/重新生成/查看大图/下载。参考建筑学长画布浮动条。
- **Why:** 重新生成与看大图是改图高频动作；连线+面板生图切片（`docs/canvas-connections-generate-design.md`）用户确认 2026-08-06 进 TODOS。
- **Context:** 面板组件（PromptPanel）落地后可复用为操作条的一项。
- **Depends on / blocked by:** 连线+面板生图切片完成后做。

## 6. 图片加工（局部重绘/细节增强/视角转换/宫格拆分）

- **What:** 建筑学长形态的图片加工能力；局部重绘需蒙版交互（涂鸦层），细节增强/视角转换是 provider 参数化调用。
- **Why:** 深化改图能力；依赖 provider 接口能力确认，且蒙版交互本身是独立工作量。
- **Depends on / blocked by:** provider 能力摸底；连线+面板生图切片完成。

## 7. 原图 vs 生成图滑块对比

- **What:** 改图场景的前后对比视图（滑块/并排）。
- **Why:** 改图验收高频；用户 2026-08-06 确认先进 TODOS（先有大图查看再说）。
- **Depends on / blocked by:** TODO 5（查看大图）优先。

## 8. Agent stop 取消粒度（thread/run 级 jobs） — DONE（H8）

- **What:** ~~`sessions.stop` 收窄到 thread~~ → `cancelThread(projectId, threadId)`；面板 `thread_id=null` 不被 stop 杀掉。
- **Done:** 2026-08-07 with H8 unified generate.

