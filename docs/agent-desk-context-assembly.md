# Agent 桌面上下文：装配规则

**状态：** 目标态装配规格（非实现、非 ADR）  
**实现进度（2026-08-10）：** Survey L0 全量目录（无件数硬上限）/ Focus / 选中 Inspect / 基础指代 / caption 已落地。桌面总览为按需工具 `look_at_desk`（`role=desk_overview`，非每轮默认注入）。主动细看 `look_at(ids|alias)` 已落地（toolResult，算 Inspect）。**产品决定不做：** 几何「左边」指代、`relative_hints` 文本、**Compare 对照块**（多选对比用 Focus+Inspect）。**已落地：** `assembly_report`（modes / focusIds / hop1Ids / inspectIds / dropped；默认不进模型）。未做：字符软预算、GT-16 overview 夹具等。  
**日期：** 2026-08-08  
**上游：** [agent-desk-perception-goals.md](agent-desk-perception-goals.md)、[agent-desk-world-model-fields.md](agent-desk-world-model-fields.md)  
**范围：** Survey / Focus / Inspect 何时触发、装什么、预算多少、如何降级与失败  
**非范围：** 字段定义（见字段表）；工具 ACI 细节；具体 system prompt 文案

---

## 1. 一句话

**每轮上下文 = 固定骨架 + 桌面投影（必有 Survey）+ 按任务叠加的 Focus / Inspect；超预算按纪律丢细节，不丢当前性与可指认目录。**

---

## 2. 装配器职责

装配器（概念组件，可与 `desk-status` 演进合并）输入：

| 输入 | 说明 |
|------|------|
| `DeskSnapshot` + 文件元数据 + 派生缓存 | 编译为 `DeskWorld` |
| `selection_ids` | 本轮 WS 选中 |
| `user_text` + 附件 | 本轮任务 |
| `resolution?` | 指代消解结果（可本轮前半段产生） |
| `mode_hints` | 工具请求 Inspect、显式 compare 列表等 |
| `budget` | token / 图片张数 / 字节 |

输出：

| 输出 | 说明 |
|------|------|
| `text_blocks[]` | 有序文本块（见 §3） |
| `images[]` | `{ index, role, alias?, artifact_id?, bytes_or_ref }` |
| `focus_ids` | 本轮焦点集合 |
| `inspect_ids` | 本轮已提供 L3 的 id |
| `assembly_report` | **已实现** `report`：modes / focusIds / hop1Ids / inspectIds / dropped（日志/评测，默认不进模型） |

规则：装配器**只投影**，不写业务事实；不发明桌面上不存在的 id。

---

## 3. 每轮固定骨架（顺序锁定）

```text
1. [system 稳定前缀]          — 身份、工具纪律、诚实规则（不经装配器改）
2. [user 本轮原文 + 附件清单]
3. [DESK_CONTEXT ...]         — Survey 文本（必有；失败见 §9）
4. [FOCUS ...]                — 可选
5. [INSPECT / image index]    — 可选；与 images[] 对齐
6. [JOBS / 最近变更]          — 可并入 DESK 或独立短块
7. [RESOLUTION ...]           — 可选：指代结果或候选
```
（**无** `[COMPARE]`：产品决定不做独立对照块。）

约束：

- **3 不得省略**（桌面不可用时用降级块，见 §9）。  
- **历史消息里的旧 DESK 块不参与「当前局面」**；仅本轮 `current=true` 有效。  
- 动态块全部**后置**，利于 KV 前缀稳定。

---

## 4. 看见模式总表

| 模式 | 目的 | 默认触发 | 文本 | 视觉 | 可否单独出现 |
|------|------|----------|------|------|--------------|
| **Survey** | 不盲、可指认 | **每轮必开** | 全桌 L0 + 关系 + 状态 | 可选 overview | 是（仅 Survey） |
| **Focus** | 任务相关细节 | 有焦点集合 | 焦点 L2 + 一跳 | 无（除非叠加 Inspect） | 否，叠在 Survey 上 |
| **Inspect** | 画面判断 / 改图前 | 策略或工具 | 短声明 + image index | L3 像素 | 否，叠在 Survey 上 |
| **Compare** | — | **产品决定不做** | — | — | 多选对比 → Focus + Inspect |

模式可叠加：例如 `Survey + Focus + Inspect`。  
**Survey 永远是底座**；其余是升采样。

---

## 5. 焦点集合（focus_ids）

### 5.1 构成（并集，去重，保序）

1. **Selection**：本轮 `selection_ids` 中仍在桌上的 id  
2. **Resolution**：`resolution.unique === true` 时的 `resolved_ids`  
3. **Explicit tool**：本轮已请求 look/inspect 的 id  
4. **Task seed（可选，保守）**：用户文本中显式 UUID / alias（A01）  
不自动把「全桌」或「任意 caption 相似」并入焦点。

### 5.2 空焦点

- 允许：仅 Survey。  
- 助手可先消解指代；若 `unique=false`，输出候选，**不假装已 Focus**。  
- 禁止：空焦点时对某张图做画面级断言。

### 5.3 焦点上限

| 项 | 建议默认 | 说明 |
|----|----------|------|
| `max_focus_ids` | 8 | 超出：保留 selection + resolution 顺序最前，其余进「索引 only」 |
| `max_focus_hop` | 1 | Focus 展开血缘/邻接的跳数 |
| `max_hop_extras` | 12 | 一跳扩展物件上限 |

---

## 6. Survey（扫视）

### 6.1 触发

- **每轮强制**（含空桌、桌面读取失败的降级形态）。

### 6.2 必装内容

**头：**

```text
[DESK_CONTEXT current=true revision=<rev> project=<id> name=<name> objects=<n> connections=<m>]
```

**选中：**

- 无选中：`选中：无`  
- 有：逐条 `alias | type | id | label | lifecycle`；无效 id 标 `无效`  

**物件目录（L0）：** 每件一行，字段见字段表 §8 L0。  
**连线表：** `from_alias → to_alias (ids)`。  
**jobs_summary：** 进行中/最近失败的异步任务（若有）。

### 6.3 可选内容

| 项 | 默认建议 | 条件 |
|----|----------|------|
| L1 roles / lineage 简表 | **开**（近默认） | 非 stale；超预算可关 |
| `relative_hints` 全局 | **关（产品决定不做）** | 不注入 Focus 旁注 |
| 几何「左边」等相对选中消解 | **关（产品决定不做）** | 不靠 pose 消解口语方位；用户点选 / A0x / 可区分名称 |
| `overview_image` | **按需工具，非每轮默认** | 助手调用 `look_at_desk`；失败/未调用则纯文本 Survey |
| alias 稳定跨轮 | 不要求 | 单轮块内必须自洽 |

### 6.4 视觉总览规则

**落地形态：** 工具 `look_at_desk`（路径 A：toolResult 内联 ImageContent），**不是**每轮 `session.prompt` 前缀塞图。

若本轮出现 overview（工具结果内）：

1. 明确 `role=desk_overview`；与用户轮 `[INSPECT]` 的 `image_N` **编号隔离**（勿混用）。  
2. 缩略按 pose 排布；标 alias；选中高亮；画显式连线。  
3. 工具文本声明：总览仅布局/编号；**禁止**替代 Inspect 做材质/比例/验收。  
4. overview **不计入** `inspect_ids`。  
5. 无 ready 像素 / 超时 / 超字节 → 整工具失败，不塞半张图。

### 6.5 Survey 目录（无硬编码件数上限）

- Survey **列出桌上全部物件与编号表**；`objects=N` 与列表一致，**禁止** `max_survey_objects` 一类硬截断。
- 大桌成本靠：短 L0 行、Focus/Inspect 升采样、`look_at_desk` / `look_at` 按需拉视觉——**不靠砍目录**。
- 若未来因 token 必须压缩：用 token/字节预算 + **焦点优先 + 短索引兜底**，不得静默丢掉选中/焦点/任意 alias 的可指认性。

---

## 7. Focus（聚焦）

### 7.1 触发（满足任一）

- `focus_ids` 非空  
- 或 工具/策略声明需要 L2（即使稍后 Inspect）

### 7.2 必装内容

对每个 `focus_id`（及一跳扩展，标为 `hop=1`）：

- L0 行（可与 Survey 去重：Survey 已有则 Focus 块只补 L2）  
- **Intent**：`user_prompt` / 关键 composed 摘要 / region 有无  
- **Visual**：caption / 关键 attributes（必须带 `source`；`stale` 须标明）  
- **结构**：`edges_in/out`、lineage 父母子女  
- **文件**：`original_filename`、`pixels_available`  

### 7.3 不装

- 全桌每个物件的 caption  
- L3 像素（除非叠加 Inspect）  
- stale caption 当 fresh（可写「过期观察：…」或省略 value）

### 7.4 一跳扩展

- 沿 **显式连线** 取父母/子女；**不做**几何最近邻自动并入焦点。  
- 扩展物件默认 **L1 + 短 L2（仅 label/lifecycle/intent 一行）**；只有仍在 `focus_ids` 核心集才给满 L2。

---

## 8. Inspect（细看）

### 8.1 触发

| 触发源 | 行为 |
|--------|------|
| 用户选中且 `pixels_available` | **自动 Inspect 选中**（与现状对齐，可配置上限） |
| 指代唯一消解且任务像改图/评价画面 | 建议 Inspect resolved |
| 助手/工具 `look_at_desk` | 整桌总览 1 张（非 L3） |
| 助手/工具显式 `look_at`(ids) | 按请求 id/alias 升 L3（toolResult，算 Inspect） |
| 仅闲聊/问桌上有什么 | **不**自动 Inspect |

### 8.2 必装内容

- 文本：`[INSPECT]` + image index 表  
- `images[]`：每张图 `role=inspect` + `alias` + `artifact_id`  
- 仅 `lifecycle=ready` 且有 file 的物件；pending/empty/failed **不进 L3**，文本说明原因  

### 8.3 上限

| 项 | 建议默认 |
|----|----------|
| `max_inspect_images` | 4（不含 overview） |
| 优先级 | selection 顺序 > resolution > 显式 tool > 其它焦点 |
| 超出 | 未进 L3 的焦点保留 L2，并声明 `未附原图：A05…` |

### 8.4 诚实约束（硬）

- 未出现在 `inspect_ids` 的物件 → 不得做像素级断言。  
- 仅有 caption → 必须标明为视觉观察/过期观察。  
- overview 不计入 `inspect_ids`。

### 8.5 与附件去重

- 同一 `file_id` 已在聊天附件 → 不重复塞字节；index 表可写 `见附件 file_id=…` 或共享引用。

---

## 9. Compare（对比）— **不做**

**产品决定不做**独立 `[COMPARE]` 装配模式与 `max_compare_items`。

- 用户多选多张、话术像「对比 / 哪个更…」时：**不**额外生成对照表。  
- **现行路径：** 多 id 进入 Focus core + 预算内 Inspect；由模型基于 Focus/Inspect 自行比较。  
- 历史规格中的对照表触发/字段仅作归档理解，**不作为实现目标**。

---

## 10. 预算模型

三类预算**同时**约束（任一触顶即降级）：

| 预算 | 建议默认（目标量级，实现可配置） | 计量 |
|------|----------------------------------|------|
| `max_desk_text_tokens` | 3k–6k | DESK+FOCUS 文本（可选软预算；无件数硬上限） |
| `max_images` | 1 overview + 4 inspect | 张数 |
| `max_image_bytes` | 按现有 agent 图像加载上限对齐 | 解码前/后与实现一致即可 |

不设「只限物件数」为唯一闸门；物件数截断是文本侧手段之一。

### 10.1 降级顺序（与字段表 §8 一致，装配级展开）

触顶时**按序丢弃**（先丢的在前）：

1. 非焦点 hop=1 的 L2 visual  
2. 非焦点细节（caption 等）  
3. （已取消）Compare / relative_hints — 产品不做  
4. **overview_image**  
5. 非焦点 L1 roles / lineage 详情（保留连线表精简版）  
6. Survey 非焦点物件改为超短索引行  
7. Inspect 张数按 §8.3 优先级裁切  
8. **禁止丢弃：** `DESK_CONTEXT` 头、`revision`/`current`、选中列表、焦点 L0 行、image index 与图的对应关系  

### 10.2 降级必须可观测

`AssembledDeskContext.report`（`buildAssemblyReport`）：

```text
modes: survey | resolution? | focus? | inspect?
focusIds / hop1Ids / inspectIds
dropped:
  - snapshot_unavailable
  - focus_hop:{artifactId}:over_budget
  - inspect:{artifactId}:{pending|empty|failed|over_budget|…}
```

评测与日志使用；**默认不注入模型**。若丢了 Inspect，文本 `[INSPECT]` 仍写「未附原图」。

---

## 11. 指代与装配的衔接

```text
user_text → resolve(name/role/spatial/link)
  → unique?
       yes → focus_ids ∪= resolved；可触发 Focus/Inspect
       no  → [RESOLUTION] 候选 + basis；不自动 Inspect
```

- 消解在装配 **Focus/Inspect 之前**（同一轮可先规则消解再装）。  
- 模型也可调用工具再看；但**首轮装配不得依赖模型先猜对 id**。  
- caption 相似不得单独产生 `unique=true`。

---

## 12. 失败与降级路径

| 失败 | 装配行为 |
|------|----------|
| `snapshot` 读取失败 | `[DESK_CONTEXT current=true revision=unknown]` + `桌面状态暂不可用`；无 Focus/Inspect 桌面图；附件仍可 |
| 单个 file 读失败 | 该 id `pixels_available=false`；跳过 L3；注明缺失 |
| caption 缓存 stale/缺失 | Focus 可仅 Intent + 结构；不编造 caption |
| overview 渲染失败 | 纯文本 Survey |
| 全部 Inspect 失败 | 保留 Survey+Focus；禁止画面断言 |
| selection 含已删 id | 标无效；不进入 focus 有效集 |

---

## 13. 与 episode memory 的边界

| 层 | 谁写 | 权威 |
|----|------|------|
| 本轮 DESK/FOCUS/INSPECT | 装配器 | **当前局面** |
| pi JSONL 历史 | 会话 | 过程与工具轨迹；**含旧桌面叙述时不得压过本轮 DESK** |
| chat_messages | 产品 UI | 不对模型冒充完整 world state |

system 纪律应包含：以本轮 `current=true` 的 DESK 为准。

---

## 14. 现状对照（实现进度，2026-08-08）

| 规则 | 现状 |
|------|------|
| 每轮 Survey L0 | 已落地：alias、可区分 label、lifecycle、grid、连线、revision 头 |
| Focus L2 | 已落地：intent、一跳、caption（cache hit） |
| Inspect | 选中自动 + `image_N` index；pending 不进 L3 |
| Compare | **不做**（多选 → Focus+Inspect） |
| overview | **按需** `look_at_desk`（desk_overview）；非每轮默认 |
| revision 头 | 已有 |
| 预算降级 | Survey **无**件数硬截断（全量 L0）；`report.dropped` **已有**；字符软预算未做 |
| 几何「左边」指代 | **不做**（与 `relative_hints` 同） |

演进方向（余量）：指代权威（GT-09）、字符软预算、GT-16。**不做：** 几何方位消解、`relative_hints`、Compare 对照块。

---

## 15. 验收钩子（供黄金任务引用）

装配结果应能断言：

1. 每轮存在且仅一条逻辑「当前」DESK 头（`current=true` + revision）。  
2. 焦点 id 的 L0 行未被截断丢弃。  
3. `inspect_ids` 与 `images[]` 中 `role=inspect` 一致。  
4. 超预算时 report 记录 dropped；焦点 Inspect 优先于非焦点。  
5. `unique=false` 时无单 id 静默 Focus 当唯一真源。  
6. overview 不在 `inspect_ids`。  
7. pending 物件不出现在 Inspect 图里。

---

## 16. 配置面（实现时可做成常量/配置）

```text
// Survey：全桌目录，无 max_survey_objects 硬上限
max_focus_ids = 8
max_focus_hop = 1
max_hop_extras = 12
max_inspect_images = 4
// max_compare_items — 不做 Compare
overview_mode = on_demand_tool   // look_at_desk；非 per_turn_survey
// overview_enabled = true       // 旧「每轮优先尝试」已弃用
auto_inspect_selection = true
auto_inspect_resolved_on_edit_intent = true  // 启发式，可关
// max_desk_text_tokens：可选预算钩子；触发时焦点优先+短索引，禁止砍可指认目录
```

---

## 17. 下游

1. **黄金任务集** — 用 §15 做夹具断言 → [agent-desk-golden-tasks.md](agent-desk-golden-tasks.md)  
2. **实现切片** — 编译 `DeskWorld` → 按本文装配 → 替换/扩展 `buildDeskStatusBlock`  
3. **look_at / caption worker** — 只扩展 Inspect/Focus 输入，不改变骨架顺序  

---

## 18. 一句话

**装配 = 每轮强制 Survey 底座 + 焦点驱动的 Focus/Inspect 升采样；预算先砍总览与非焦点细节，永不砍当前 revision 与可指认目录；没进 Inspect 的图就不能装成「看过」。无独立 Compare 块。**
