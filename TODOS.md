# TODOS

## 1. 服务端操作历史（跨刷新撤销/重做）

- **What:** `desk_operations` 表（id/project_id/sequence/type/payload/inverse/created_at/created_by）+ `desk_state.history_head` 指针 + `POST /api/projects/:id/desk/undo|redo` + GET desk 带 canUndo/canRedo；place/move/remove/update_text 同一事务写 log；cap 100-200 条；remove 改 tombstone（artifacts.deleted_at）。
- **Why:** Agent 桌面 tools 落地后需要与人工共用同一历史模型；跨刷新撤销是原产品承诺（office-hours Approach B，2026-08-06 eng review D3 降级为会话内，决策见 gstack decision log）。
- **Pros:** 刷新/崩溃后误操作可恢复；Agent 写桌可直接复用；undoable 事件字段已预留。
- **Cons:** 工期 L；需处理日志与版本链边界、cap 截断窗口与 canUndo 计算。
- **Context:** 设计全文见 `docs/canvas-toolbar-history-design.md` 修订前版本（git 历史）及 `~/.gstack/projects/1797127235-qijian-ai-design/liu-codex-canvas-reliability-design-20260806-111110.md`。删除语义当时定的是 tombstone（D2 分析：日志快照方案会导致文件 409 保护失效）。启动时机：Agent 桌面 tools 切片。
- **Depends on / blocked by:** Agent 写桌需求出现前不做。

## 2. 孤儿上传文件 GC — DONE（最小闭环）

- **What:** ~~定期（或手动触发）清理不被任何 artifact（payload.file_id / input_refs）或聊天消息引用的 `stored_files` 行 + 磁盘字节。~~
- **Done (2026-08-09):** `FileStorage.gcUnattached({ projectId?, minAgeMs=1h, limit })` + `POST /api/projects/:id/files/gc`；复用 reference checkers（artifact/chat/cover）；默认跳过 1h 内文件保护会话 undo。`referencesFile` 补 `payload.reference_file_id`。集成回归：`deletePlaced leaves the canvas image file on disk`。
- **Also done:** 删物件后 best-effort 异步 GC（`setObjectDeletedListener` → `gcUnattached`，minAge 内跳过）。
- **Still open (optional):** 启动/定时扫全库、InpaintDialog 取消清理临时参考图。
- **Why (historical):** 主路径上传失败前端已 `deleteFile`；真泄漏是硬删物件不级联清文件 + 无扫孤儿。
- **Depends on / blocked by:** 无；若做 TODO 1 tombstone，checker 需继续认墓碑引用。

## 3. 跨标签页 desk 同步（WS 广播） — DONE

- **What:** ~~desk 的 HTTP 变更广播 `object_changed`；前端 refetch~~。
- **Done (2026-08-09):** `createDeskContentChangedHandler` 挂在 `desks`/`artifacts` 的 `setDeskChangedListener`：cover 重渲 + `publish({ type: "object_changed", projectId })`（无 artifactId，避免他 tab 抢焦点）。place/move/delete/connection/append/rollback/generate 写路径凡走 `emitDeskChanged` 均覆盖。前端既有 `useChatSession` refetch 无需改。
- **Note:** Agent/Job 仍可能再发带 `artifactId` 的 `object_changed`（焦点/history）；双发可接受。
- **Why (historical):** 原先仅 Agent 路径发事件，HTTP 多 tab 陈旧。

## 4. PDF 画布预览 — CUT

- **Status:** 砍掉（2026-08-09）。画布继续只认 JPEG/PNG；PDF 不进预览路线。
- **Historical:** 曾计划整文件引用 + pdf.js 首页预览；deps 里仍有 `pdfjs-dist` / `@napi-rs/canvas`，上传管线 `inspectUpload` 仍可提 pageCount，但不做画布渲染。

## 5. 选中物件浮动操作条 — CUT

- **Status:** 砍掉（2026-08-09）。不再做统一浮动条上的「重新生成 / 下载」与更密工具排布。
- **Keep as-is:** 节点工具条局部重绘、双击/大图 lightbox、选中即开 Prompt 面板。

## 6. 图片加工（局部重绘/细节增强/视角转换/宫格拆分） — 部分完成

- **What:** 局部重绘（蒙版级）+ 细节增强 / 视角转换 / 宫格拆分。
- **Done (partial):** 矩形框选局部重绘（`InpaintDialog` + generate region/reference）已落地，见 `docs/canvas-inpainting-design.md`。
- **Still open:** 涂鸦蒙版、细节增强、视角转换、宫格拆分；依赖 provider 参数化能力。
- **Depends on / blocked by:** provider 摸底。

## 7. 原图 vs 生成图滑块对比

- **What:** 改图场景的前后对比视图（滑块/并排）。
- **Why:** 改图验收高频；用户 2026-08-06 确认先进 TODOS。
- **Depends on / blocked by:** 大图查看已有；对比 UI 未做。

## 8. Agent stop 取消粒度（thread/run 级 jobs） — DONE（H8）

- **What:** ~~`sessions.stop` 收窄到 thread~~ → `cancelThread(projectId, threadId)`；面板 `thread_id=null` 不被 stop 杀掉。
- **Done:** 2026-08-07 with H8 unified generate.

## 9. 效果图归档 SSRF 加固（C1，暂不修）

- **What:** `HttpImageGenerator.download` / `assertSafeImageUrl`：下载前对 hostname 做 `dns.lookup`，对解析 IP 拒绝私网/链路本地/IPv6 ULA；或改为已知图床 host allowlist。现有实现仅校验 URL 字面量 host（localhost/私网 IPv4 字符串），挡不住 DNS rebinding 与 IPv6 绕过。
- **Why:** provider 返回的图片 URL 进入服务端下载信任边界；被污染 URL 可能扫内网。本机/可信 provider 概率低，2026-08-07 review 记为 C1，产品选择先记录不修。
- **Pros:** 合入后闭环 LLM/图像 URL 信任边界；allowlist 实现成本更低。
- **Cons:** lookup 增延迟；allowlist 换 CDN 要改配置。
- **Context:** `apps/server/src/services/image-generator.ts`（`assertSafeImageUrl` / `isPrivateOrLinkLocalHost` / `redirect: "error"` / `readBodyBounded`）。
- **Depends on / blocked by:** 无；provider 域名稳定时可先做 allowlist。

