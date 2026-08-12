# Design: 中键漫游 + 框选多选 → Agent 生图（多 from 连线）

**状态：** APPROVED（/office-hours 2026-08-07）  
**分支：** `codex/canvas-reliability`  
**模式：** Startup · Approach **A 最小可交付**  
**gstack 副本：** `~/.gstack/projects/1797127235-qijian-ai-design/liu-codex-canvas-reliability-design-20260807-113513.md`

---

## Problem Statement

设计师要把「场景图 + 材质/参考图」一次交给 AI 改图（例：客厅 + 地板材质 → 换地板）。  
现状只能：

1. 先用把手把参考**拖连线**到主图，再开面板生图；或  
2. Agent 单选一张，第二张参考进不去（`selectedArtifactIds` max 1，`generate_from_desk` 单源）。

左键空白处还被占成**漫游**，无法框选。连线路径能用，但步骤重，用户点名要「框起来就能改」。

## Demand Evidence

- 设计师/用户**明确要求**框选多图参与一次改图，不是纯对标跟风。  
- 现状 workaround = **拖连线 + 面板生图**；痛点是步骤多、不会/不愿连线。

## Status Quo

| 路径 | 代价 |
|------|------|
| 把手连线 → 面板生图 | 多步；参考语义正确但交互重 |
| 只选主图 + 打字描述材质 | 材质保真差 |
| 站外工具再拖回 | 断版本、断桌面上下文 |

连线数据模型已正确（`from=输入 → to=效果图`）；缺的是**选区入口**与 **Agent 多输入写桌**。

## Target User & Narrowest Wedge

- **用户：** 在砌间画布上做效果迭代的室内/硬装设计师（及同等工作流的自用设计者）。  
- **楔子（本周）：** 中键漫游 + 左键框选/多选 → 右侧对话多 chip → Agent `generate_from_desk` 多输入 → **一张**效果卡 + **每个参与输入一条** `from→效果图` 连线。  
- **本切片不做：** 面板生图多选改造、批量「每张各出一张」、chip「设为主图」、多选整组拖移（Approach B）。

## Constraints

- 复用 H3/H8 Job 外壳与 `CanvasGenerateService.prepare/complete`。  
- 连线语义不变：参考输入，不是装饰线。  
- 动态选中仍走轨迹末尾状态栏 / 当轮 prompt，不写进 system 前缀（KV cache）。  
- 图像 API 参考图数量有上限（实现时与 `ImageGenerator` 截断策略对齐）。  
- 触控板无中键：必须有 **Space+左键** 漫游兜底。

## Premises（已确认）

1. 左键服务选与编排；中键（+ Space+左键）服务看桌。  
2. 框选集合 = 本轮生成输入；每个参与输入 `from → 效果图`。  
3. 主源由模型 + 用户话推断；写桌须解析出唯一主源，否则拒写。  
4. 面板生图路径本切片不改。  
5. 多选有硬顶（建议 max 8，可配置），防一次框半桌爆上下文。

## Approaches Considered

### Approach A: 最小可交付（采用）

手势 + 多选状态 + 对话 chip + 工具多输入 + 多连线。面板不动。  
Effort: S–M · Risk: Med（主源推断）

### Approach B: 理想交互壳

A + chip 设主源 + 多选拖移等。Effort: L · 本周不做。

### Approach C: 只改指针

多选只进分析，生图仍单源。不解连线痛点。否决。

## Recommended Approach

**A**，因为证据是「连线太烦」，楔子必须打到 **Agent 写桌与连线**，不能只换手势。

---

## 产品行为

### 指针手势

| 输入 | 行为 |
|------|------|
| **中键拖** 空白/画布 | 漫游（pan） |
| **Space + 左键拖** | 漫游（触控板） |
| **左键拖空白** | **框选**（marquee）；松手后与矩形相交的物件进入选区 |
| **左键单击物件** | 单选（替换选区） |
| **Shift + 左键单击** | 加选 / 取消已选 |
| **左键拖物件** | 移动该物件（保持现逻辑；多选拖整组 = 非目标） |
| **左键空白单击（无拖）** | 清空选区 |
| 滚轮 | 缩放（不变） |
| 连线把手 | 不变；手势不与框选冲突（把手 stopPropagation） |

框选命中：与物件 AABB **相交**即入选（含部分落入）。  
框选过程中画半透明矩形；`pointer capture` 在 viewport 上。

### 选中状态

- `selectedId?: string` → **`selectedIds: string[]`**（有序：加选顺序；框选按稳定顺序如 y 再 x 或遍历顺序，文档实现时固定一种）。  
- 高亮：所有 `selectedIds` 带 `obj-selected`。  
- 删除键 / 工具条：作用于**全部**选中或「主焦点」——本切片建议 **Delete 删全部选中**（与多选一致）；若现逻辑只删一个，改为遍历 `selectedIds`。  
- 物件被删：从 `selectedIds` 过滤无效 id（现有 effect 扩展）。

### 右侧对话

- 每个选中物件一个 chip（规则同 Phase 0：缩略图/便签截断）。  
- chip ×：从选区移除该项。  
- 全部清空：画布空白单击或「清除选中」。  
- 发送：`selectedArtifactIds: selectedIds`（整表，受 max 截断）。

### Agent 状态栏

- 列出**全部**选中 id/kind/短描述，不只第一项。  
- 视觉附件：选中中带图的全部加载（受现有 max images / base64 预算截断，超出则状态栏注明省略）。

### `generate_from_desk`

**参数（建议）：**

```ts
{
  prompt: string;
  source_artifact_id?: string;       // 可选；模型可显式指定主源
  reference_artifact_ids?: string[]; // 可选；显式参考
}
```

**解析顺序：**

1. 若传 `source_artifact_id` → 主源 = 它。  
2. 否则若本轮 `selectedArtifactIds.length === 1` → 主源 = 该项。  
3. 否则若 `selectedArtifactIds.length >= 2` → **由模型应在调用时填 source + references**；若模型只调工具不填 source：服务端可用启发式（失败则明确 error）——**推荐：要求模型填写 source；未填则 fail**「请指定主图（要改的那张场景）」。  
4. `reference_artifact_ids` 默认 = 选中集合 − 主源；与工具参数合并去重。  
5. 主源必须在桌且为可生图类型；参考缺失则跳过并记 warning，不整单失败（除非零参考且业务需要——本场景参考可空，仅主源也可生成）。

**世界副作用（prepare）：**

1. 在主源右侧落一张 `effect_image` pending（同现逻辑）。  
2. 对 **主源 + 每个 reference** 各建一条连线 `from → effect`（幂等：已存在 from-to 不重复）。  
3. 参考图 file 并入 `referenceFileIds` / 生图 API refs；便签文案并入 composed prompt（同现 `collectReferences`，输入集合改为显式列表而非仅 inbound）。  
4. complete 后台不变（H8 Job）。

**连线示意：**

```
客厅 ────────┐
             ├──► 效果图
地板材质 ────┘
```

### 面板生图

- **不改** API 契约与单源 UI。  
- 仍可用**已有入边**作参考（现状）。  
- 与 Agent 多选路径并存；用户可继续用连线+面板。

---

## 技术改动面（实现指引，非代码）

| 层 | 文件/区域 | 改动 |
|----|-----------|------|
| 画布 | `Desk.tsx` | pan 改 button===1 与 space 键；左键空白 marquee；`selectedIds` 高亮 |
| App | `App.tsx` | `selectedIds` state；select/clear/shift；传 ChatPanel |
| 对话 | `ChatPanel` / `ChatComposer` | 多 chip；send 数组 |
| WS | `chat-socket` / `chat-gateway` | `selectedArtifactIds` max 1 → max 8（常量） |
| 状态栏 | `desk-status.ts` | 列出全部选中 |
| 工具 | `generate-from-desk.ts` | 多参考参数；解析主源 |
| 生图服务 | `canvas-generate-service.ts` | prepare 接受 `referenceArtifactIds[]`；多 `createConnection` |
| 测试 | Desk 手势单测难可 E2E/手测；gateway max；generate 多连线单测 | |

**常量建议：** `MAX_SELECTED_ARTIFACTS = 8`（前后端同一语义）。

---

## Success Criteria

1. 中键拖动画布；左键拖空白出现框选矩形，松手多物件高亮。  
2. Space+左键可漫游（不按 Space 时左键不漫游）。  
3. 多选后右侧多个 chip；发送后 Agent 状态栏含全部选中。  
4. 框选客厅+材质并说「地板换成这个材质」→ 一张效果卡；**两条**连线指向该卡。  
5. 仅单选时行为与现网兼容（单 chip、单 from 连线）。  
6. 无主源可解析时工具失败，不落幽灵卡。  
7. 面板单源生图回归通过。

## Open Questions

| # | 问题 | 默认 |
|---|------|------|
| 1 | 框选顺序 | 遍历 objects 数组顺序过滤命中 |
| 2 | max 选中 | 8 |
| 3 | 模型未填 source 时是否启发式 | **否**，直接 fail 请指定 |
| 4 | Delete 多选 | 删全部选中 |
| 5 | PromptPanel 在多选时 | 仍跟「最后单击的那张」或 primary focus；本切片可用 `selectedIds[0]` 打开面板——**推荐：仅单击打开面板，框选不自动开面板** |

## Dependencies

- H3/H8 Job 与 `generate_from_desk` 已存在。  
- 连线 API / `createConnection` 已存在。  
- 图像侧多参考：`requestWithReferences` 已有；注意提供商单图限制时截断策略要在状态栏/错误中可见。

## Distribution Plan

Web app 既有部署；无新分发渠道。需 migration：**无**（纯行为+可选常量）。

## The Assignment

**实现前：** 找一位点名要过该功能的设计师，用纸面/录屏走一遍「框两张 → 说话 → 看连线」是否符合预期；确认 max 8 与「框选不开面板」无异议。  
**实现后：** 同一人用真机跑客厅+材质案例，确认两条连线与效果卡位置。

## What I noticed about how you think

- 你用**真实任务**（客厅+地板材质）校准抽象方案，而不是先堆主源 UI。  
- 你纠正「office-hours / gstack 流程」——要可交付文档与门禁，不要口头定案。  
- 你接受「模型推断主源」，但用**连线拓扑**把结果钉在可验证的世界状态上（多 from → 一 to）。

## Non-goals（本切片）

- Approach B：chip 设主源、多选整组拖  
- 面板 HTTP 多选  
- 批量每源一卡  
- 改连线视觉语言 / 新边类型  
- multi-agent  

## Related docs

- [selection-aware phase0](2026-08-06-selection-aware-agent-phase0-design.md)  
- [generate-from-desk phase1](2026-08-06-agent-generate-from-desk-phase1-design.md)  
- [canvas connections + generate](../../canvas-connections-generate-design.md)  
- [H8 unified generate](2026-08-07-h8-unified-generate-design.md)  
- [ADR 0013](../../adr/0013-agent-generate-from-desk.md)
