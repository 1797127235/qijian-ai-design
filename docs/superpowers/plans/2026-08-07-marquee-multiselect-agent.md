# 实现计划：中键漫游 + 框选多选 → Agent 生图

**状态：** READY  
**日期：** 2026-08-07  
**分支：** `codex/canvas-reliability`  
**规格：** [2026-08-07-marquee-multiselect-agent-design.md](../specs/2026-08-07-marquee-multiselect-agent-design.md)  
**相关：** Phase 0 单选、ADR 0013、H8 Job 外壳

---

## 0. 完成定义

| # | 标准 | 验证 |
|---|------|------|
| 1 | 中键拖 = 漫游；Space+左键 = 漫游 | 手测 |
| 2 | 左键拖空白 = 框选矩形，松手多选高亮 | 手测 |
| 3 | 单击单选；Shift+单击加选/取消 | 手测 |
| 4 | 右侧多 chip；发送 `selectedArtifactIds` 多 id | 单测 gateway + 手测 |
| 5 | 状态栏列出全部选中 | desk-status 单测 |
| 6 | 多选生图：一效果卡 + 每输入一条 `from→效果` | generate 单测 + 手测 |
| 7 | 多选未填 source → 工具 fail，不落卡 | tool 单测 |
| 8 | 单选路径与面板生图回归绿 | 现有测试 + 手测 |

**常量：** `MAX_SELECTED_ARTIFACTS = 8`（前后端一致；建议放 `src/shared/` 或 server domain + 前端 mirror）。

---

## 1. 切片与依赖

```
T1 共享常量 + gateway/desk-status 多选
        │
        ▼
T2 App/Desk 手势 + selectedIds 状态 ──► T3 Chat 多 chip
        │
        ▼
T4 generate_from_desk + CanvasGenerate 多参考/多连线
        │
        ▼
T5 测试 + 文档 + 手测清单
```

建议 **一个 PR、按 commit 切**（T1→T5），或 PR1=T1–T3（可先发多选分析）、PR2=T4 写桌。

**推荐一次竖切：** T1–T4 同 PR，避免「能多选但不能生图」半成品外泄。

---

## 2. T1 — 协议与状态栏（后端先放宽）

### 2.1 常量

| 位置 | 内容 |
|------|------|
| 新建或扩展 shared | `MAX_SELECTED_ARTIFACTS = 8` |
| `apps/server/.../chat-gateway.ts` | `z.array(...).max(MAX_SELECTED_ARTIFACTS)` 替换 `.max(1)` |
| 前端 send 路径 | 发送前 `slice(0, MAX)`（防脏状态） |

### 2.2 `desk-status.ts`

- `buildDeskStatusBlock`：列出**全部**选中（id/kind/短描述），不只 `[0]`。  
- 超长时截断列表并注「另有 N 项未列出」（若视觉预算紧）。  
- `selectedVisualFileIds`：已遍历数组则保持；确认预算截断行为与文案。

### 2.3 测试

- `chat-gateway.test.ts`：接受 2 个 id；拒绝 9 个。  
- `desk-status.test.ts`：两选中均出现在 block。

### 2.4 验收

- 旧客户端只发 1 个 id 仍兼容。

---

## 3. T2 — 画布手势 + `selectedIds`

### 3.1 状态（`App.tsx`）

```ts
// 替换 selectedId
const [selectedIds, setSelectedIds] = useState<string[]>([]);
// 派生：lastClickId 仅用于 PromptPanel（单击打开面板）
const [panelAnchorId, setPanelAnchorId] = useState<string>(); // 或复用 gen.panelSourceId
```

| 操作 | 状态更新 |
|------|----------|
| 单击物件 | `selectedIds = [id]`；`onSelect(id, { panel: true })` 开面板 |
| Shift+单击 | toggle id in selectedIds；**不开**面板（或 panel:false） |
| 框选松手 | `selectedIds = hits`（objects 遍历顺序过滤相交）；**不开**面板 |
| 空白单击 | `selectedIds = []`；关面板 |
| 物件删除后 | filter 无效 id |
| Delete | 对 `selectedIds` 逐个 deleteObject（或批量） |

`useDeskPlacement`：`selectedId` → 支持 `selectedIds` 或传入「主删除列表」。

### 3.2 `Desk.tsx` 指针

| 条件 | 行为 |
|------|------|
| `e.button === 1`（中键）在 viewport | startPan（现 startPan 逻辑） |
| Space 按下 + `e.button === 0` 空白 | startPan |
| `e.button === 0` 空白且无 Space | **startMarquee**（非 pan） |
| `e.button === 0` 物件 | 现有 select/drag；读 `e.shiftKey` 通知 App |

实现要点：

1. **Space 键：** `useEffect` 监听 keydown/keyup，`spaceHeld` ref；blur 时清 false。  
2. **Marquee：**  
   - pointerdown 空白：记录 world 起点，`setMarquee({ x1,y1,x2,y2 })`  
   - move：更新 x2,y2  
   - up：AABB 相交检测 → `onMarqueeSelect?.(ids)`；清矩形  
3. **中键：** `button === 1`；`preventDefault` 避免自动滚动（auxclick 也要管）。  
4. **高亮：** `selectedIds.includes(obj.id)` → `obj-selected`。  
5. **Props：**  
   - `selectedIds: string[]`  
   - `onSelect?: (id?: string, opts?: { panel?: boolean; toggle?: boolean }) => void`  
   - `onMarqueeSelect?: (ids: string[]) => void`  
   - 或统一 `onSelectionChange(ids, meta)`

### 3.3 CSS

- `.desk-marquee`：半透明描边矩形，`pointer-events: none`。  
- 中键漫游时 `cursor: grabbing`。

### 3.4 验收

- 左键拖空白**不再**平移画布。  
- 框选两图均高亮；单击第三张变单选。

---

## 4. T3 — 对话多 chip

### 4.1 组件

| 文件 | 改动 |
|------|------|
| `ChatComposer.tsx` | `selectedObject?` → `selectedObjects: DeskObject[]`；map 多 chip；每 chip 独立 onClear(id) |
| `ChatPanel.tsx` | 传入数组；send `selectedArtifactIds: selectedObjects.map(o => o.id).slice(0, MAX)` |
| `App.tsx` | `selectedObjects = selectedIds.map(id => objects.find...).filter(Boolean)` |

Chip ×：`setSelectedIds(ids => ids.filter(x => x !== id))`。  
清除全部：现有 onClearSelection → `setSelectedIds([])`。

### 4.2 验收

- 两选中 → 两 chip；发一条消息 network/WS 含两个 id。

---

## 5. T4 — 生图多参考 + 多连线

### 5.1 `GenerateFromCanvasInput` 扩展

```ts
referenceArtifactIds?: string[]; // 显式参考（不含主源）
```

`prepare` / `prepareNewTarget`：

1. 布局锚点 = `sourceArtifactId`（主源）。  
2. 连线：对 `[source, ...references]` 各 `createConnection(from, effectId)`。  
3. `collectReferences`：改为基于 **显式 id 列表**（主源 + references + 可选保留主源上原有 inbound——**推荐本切片：显式列表优先，并并入主源既有 inbound 去重**，避免丢掉用户已拖的线）。

设计默认：**参与输入 = 主源 + reference_artifact_ids（默认选中−主源）**；实现时：

```
inputs = unique([source, ...refsFromTool, ...refsFromSelectionDefault])
// 再可选 merge inbound(source)
```

返回值：若 API 只返回单 `connection`，扩展为 `connections: DeskConnection[]` 或主 connection + 侧效已写入 desk（snapshot 为准）。前端 history record 至少记主 connection；其余连线随 desk 存在即可（undo generate 删卡会级联清线）。

### 5.2 `generate-from-desk` 工具

```ts
parameters: {
  prompt,
  source_artifact_id?: string,
  reference_artifact_ids?: string[],
}
```

解析（严格）：

```
source = params.source_artifact_id
      ?? (selected.length === 1 ? selected[0] : undefined)
if (!source) fail("请指定主图 source_artifact_id（要改的那张场景）")
refs = unique([
  ...(params.reference_artifact_ids ?? []),
  ...selected.filter(id => id !== source),
])
// 去掉无效 id
prepare({ sourceArtifactId: source, referenceArtifactIds: refs, ... })
```

Guidelines / system 补一句：多选改图时**必须**传 `source_artifact_id`，其余为参考。

### 5.3 测试

- prepare mock：2 refs → createConnection 调用 2+ 次（主源+参考）或 2 次仅参考+主源共 2。  
- 工具：selected 2 个且无 source → fail。  
- 工具：显式 source + 1 ref → prepare 参数正确。

### 5.4 验收

- 手测客厅+材质 → 一卡两线。

---

## 6. T5 — 收尾

| 项 | 动作 |
|----|------|
| 全量 `npm test` | 绿 |
| 规格状态 | 可保持 APPROVED；plan → IMPLEMENTED |
| `TODOS.md` | 可选记「Approach B：主源 chip / 多选拖」 |
| harness / frontier | 若写「选中 max1」处改为 max8 |
| 手测清单 | 见下 |

### 手测清单

1. 中键 pan；Space+左键 pan；左键空白框选。  
2. Shift 加选；chip 与高亮一致。  
3. 单选生图（Agent + 面板）回归。  
4. 双选 +「地板换成参考材质」→ 双连线 + 一效果卡。  
5. 双选不说主源、模型也不传 source → 失败文案，无新卡。  
6. 框选 9 个 → 最多 8 进 WS（或 UI 提示）。

---

## 7. 文件级 checklist

### 前端

- [ ] `src/desk/Desk.tsx` — 手势 + marquee + selectedIds 高亮  
- [ ] `src/desk/desk.css` — marquee 样式  
- [ ] `src/app/App.tsx` — selectedIds 状态机  
- [ ] `src/app/useDeskPlacement.ts` — 多选删除  
- [ ] `src/desk/ChatPanel.tsx` / `ChatComposer.tsx` — 多 chip  
- [ ] `src/lib/api/chat-socket.ts` — 无需改形状（已是数组）  
- [ ] shared `MAX_SELECTED_ARTIFACTS`

### 后端

- [ ] `chat-gateway.ts` — max 8  
- [ ] `desk-status.ts` + test  
- [ ] `generate-from-desk.ts` + test + system-prompt guidelines  
- [ ] `canvas-generate-service.ts` — referenceArtifactIds + 多 connection  
- [ ] 相关 service 测试

### 文档

- [ ] plan 状态 IMPLEMENTED  
- [ ] 可选 TODOS Approach B  

---

## 8. 实现顺序（执行时勾选）

1. **T1** 常量 + gateway max + desk-status 全文选中  
2. **T2** Desk 中键/Space pan + marquee；App selectedIds  
3. **T3** 多 chip 发送  
4. **T4** prepare 多连线 + 工具解析  
5. **T5** 测试 + 手测  

每步后跑相关 vitest。

---

## 9. 风险与回滚

| 风险 | 缓解 |
|------|------|
| 中键被浏览器默认行为吃掉 | preventDefault on auxclick/mousedown button1 |
| Space 与输入框抢键 | 仅 viewport focus 或 target 非 input 时响应 Space pan |
| 框选与连线把手冲突 | 把手 stopPropagation（已有） |
| 多参考超图像 API 限制 | 截断 + 错误/状态栏可见（沿用 image-generator） |
| 模型总不传 source | guidelines + fail 文案；B 期再加 chip 主源 |

回滚：git revert；协议 max 改回 1 会破坏已发多选客户端——前进兼容只增不减 max。

---

## 10. 非本计划

- Approach B（主源 chip、多选整组拖）  
- 面板 HTTP 多选  
- 批量每源一卡  
- 服务端 selection 推送事件  

---

## 11. 预估工作量

| 切片 | 体量 |
|------|------|
| T1 | S |
| T2 | M（手势边界最多） |
| T3 | S |
| T4 | M |
| T5 | S |

合计约 **1 个专注开发日** 量级（含手测），视手势边角可 +0.5 日。
