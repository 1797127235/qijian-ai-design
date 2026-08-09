# Agent 桌面世界模型：字段表

**状态：** 目标态字段规格（非实现、非 ADR）  
**实现进度（2026-08-10）：** 字段中 L0 Survey、Focus intent/caption、Inspect 已用；`overview_image` 由按需工具 `look_at_desk` 提供（非每轮装配默认）。**产品决定不做：** `relative_hints` 文本；几何「左边」等相对选中指代消解；独立 **Compare** 装配块。  
**日期：** 2026-08-08  
**上游：** [agent-desk-perception-goals.md](agent-desk-perception-goals.md)  
**范围：** 桌面感知读模型的字段定义——来源、权威、更新、失效、进哪一层上下文  
**非范围：** Survey/Focus/Inspect 的装配预算与降级细则（见 [agent-desk-context-assembly.md](agent-desk-context-assembly.md)）；工具 API 形状；具体 prompt 文案

---

## 1. 原则（必须遵守）

1. **World state 是编译出的读模型**，不是第二份业务库。写路径仍改 Artifact / `desk_state` / 文件；感知模块从事实源投影。
2. **字段分原生与派生。** 原生可信赖；派生必须能回答：谁提供、基于哪一版、是否仍有效。
3. **是否采信看权威与可核对性，不看 confidence。** `confidence` 仅可选诊断。
4. **名称三层：** `artifactId`（机器）/ `displayName`（用户）/ `fallbackName`（系统）；prompt 不当名字。
5. **角色 ≠ 类型 ≠ 生命周期状态。** `artifactType` 是记录形态；`roles` 是设计/任务用途；`lifecycle` 是 empty/pending/ready/failed。
6. **Intent ≠ Visual。** 生成意图不能冒充画面事实。
7. **当前 desk 压过历史。** 投影带 `revision` + `current=true`；旧投影不可覆盖存在性与版本。

---

## 2. 图例

| 列 | 含义 |
|----|------|
| **字段** | 读模型字段名（目标态；实现可映射/改名） |
| **类型** | 概念类型 |
| **来源** | `system` / `user` / `vision` / `geometry` / `generation` / `session` |
| **权威** | 采信优先级：`absolute` > `high` > `derived` > `hint` |
| **存储** | `fact` 业务事实源 · `cache` 可重算缓存 · `ephemeral` 仅运行时 · `never` 不落库 |
| **更新** | 何时产生/刷新 |
| **失效** | 何时 `stale` 或丢弃 |
| **层** | 默认进入：L0 / L1 / L2 / L3 / 模式专用 |

权威与采信（复述上游）：

1. `absolute` 系统事实  
2. `high` 用户事实  
3. `derived` 可重算几何 / 显式连线  
4. `hint` 视觉/模型观察（默认可错）  
5. 未 Inspect / 指代不唯一 → 不静默选定  

---

## 3. 派生值信封（Derived\<T\>）

凡非原生字段，逻辑上视为：

```text
Derived<T> {
  value: T
  source: system | user | vision | geometry | generation
  derived_from?: {
    artifact_id?: string
    version_id?: string
    version_no?: number
    file_id?: string
    content_hash?: string   // stored_files 或像素内容
    analyzer_version?: string
  }
  observed_at?: string      // ISO time
  stale: boolean
  confidence?: low | medium | high   // 可选诊断；禁止作门闸
}
```

规则：

- `source=user` 的值，不因 vision 高分被覆盖。  
- 依赖的 `version_id` / `content_hash` 变化 → `stale=true`，不得当 fresh 事实用。  
- `stale` 的 L1/L2 可展示为「过期观察」，不可支撑静默指代或验收结论。  
- 装配器可省略未用元数据，但**不得丢掉 source/stale 语义**。

---

## 4. 桌面级（DeskWorld）

| 字段 | 类型 | 来源 | 权威 | 存储 | 更新 | 失效 | 层 |
|------|------|------|------|------|------|------|-----|
| `project.id` | string | system | absolute | fact | 项目创建 | 项目删除 | L0 |
| `project.name` | string | system/user | high | fact | 改名 | — | L0 |
| `revision` | string \| number | system | absolute | ephemeral | 每次投影编译；建议 hash(desk_state.updatedAt + artifacts 当前 version 集合) | 下一 revision 取代 | **每轮必带** |
| `current` | boolean | system | absolute | ephemeral | 注入上下文时恒为 `true` | 历史消息中的旧块视为 `current=false` | **每轮必带** |
| `object_count` | number | system | absolute | ephemeral | 投影时 | — | L0 |
| `connection_count` | number | system | absolute | ephemeral | 投影时 | — | L0 |
| `viewport` | `{x,y,zoom}` | system | absolute | fact | 用户平移缩放 | — | 一般不进模型；总览渲染用 |
| `selection_ids` | string[] | session | high | ephemeral | 本轮 prompt 携带 | 本轮结束 | L0 选中块 |
| `alias_map` | `Record<alias, artifactId>` | system | absolute | ephemeral | 本轮投影内稳定编号（如 A01…） | 下一 revision 可重排（须在块内自洽） | L0 + 总览 |
| `jobs_summary` | 异步任务摘要 | system | absolute | fact/ephemeral | job store | 任务终态后可折叠 | Survey 附带 |
| `overview_image` | 视觉引用 | geometry+system | hint\* | ephemeral | **按需** `look_at_desk` 渲染缩略拼板（非每轮默认） | revision 变则重渲 | 工具视觉；**不替代 L3** |

\*总览图用于局面与编号对应，权威不足以做材质/比例验收。

### 4.1 投影头（强制）

每次注入的桌面块逻辑头：

```text
[DESK_CONTEXT current=true revision=<rev> project=<id> name=<name> objects=<n>]
```

历史 thread 中若残留旧块，规则：**仅最新 `current=true` 为局面权威**。

---

## 5. 物件级（DeskObjectWorld）

仅包含 **已放置在 `desk_state.objects` 上的** artifact。未放置 artifact 默认不进桌面世界模型。

### 5.1 身份 Identity

| 字段 | 类型 | 来源 | 权威 | 存储 | 更新 | 失效 | 层 |
|------|------|------|------|------|------|------|-----|
| `artifact_id` | uuid | system | absolute | fact | 创建 | 删除 | L0；工具唯一键 |
| `alias` | string | system | absolute | ephemeral | 本轮编号 | revision | L0；指代辅助 |
| `artifact_type` | `canvas_image` \| `effect_image` | system | absolute | fact | 创建（不可变） | — | L0 |
| `display_name` | string \| null | user | high | fact（待产品字段） | 用户命名/改名 | 用户清空 → null | L0（有则优先展示） |
| `fallback_name` | string | system | derived | ephemeral | 投影时按规则生成 | 输入信号变则变 | L0 |
| `label` | string | system | derived | ephemeral | `display_name ?? fallback_name` | 同上 | **L0 对外短名** |
| `created_by` | `designer` \| `agent` | system | absolute | fact | 创建 | — | L1 可选 |
| `version_id` | uuid | system | absolute | fact | 当前版本指针 | 新版本 | L0/L1 |
| `version_no` | number | system | absolute | fact | 当前版本 | 新版本 | L1 可选 |
| `lifecycle` | 见下 | system | absolute | ephemeral | 由 payload 推导 | payload 变 | L0 |

**lifecycle（生命周期，不是 role）：**

| 值 | 条件（现状 payload） |
|----|----------------------|
| `empty` | canvas 无 file_id、非 pending、无 error |
| `pending` | `payload.pending === true` |
| `failed` | 有非空 `payload.error` |
| `ready` | 有有效 `file_id` 且非 pending |

**fallback_name 生成顺序（目标规则）：**

1. `canvas_image` + `file_id` → `stored_files.original_filename` 去扩展名  
2. `effect_image` + ready → 不用 prompt 当名；用「效果图-N」或「从 {源 label} 生成-N」若血缘可知  
3. `pending` → `生成中-N`  
4. `failed` → `生成失败-N`  
5. `empty` → `空图-N`  
6. 同名冲突 → 类型内序号保证桌内唯一  

**禁止：** 用 `user_prompt` / `prompt` 全文当 `fallback_name`（属 Intent，见 5.4）。  
**现状差距：** 今日 shortLabel 仍用 prompt 截断当效果图标签——目标态应拆开。

### 5.2 角色 Role

| 字段 | 类型 | 来源 | 权威 | 存储 | 更新 | 失效 | 层 |
|------|------|------|------|------|------|------|-----|
| `standing_roles` | `Derived<RoleTag>[]` | user / generation / vision | high 若 user；否则 hint | cache 或 fact(user) | 用户标注；或生成时写入；或视觉建议 | 用户改写覆盖；vision 随 version/hash | L1 |
| `task_roles` | `RoleTag[]` | session | high（本轮） | ephemeral | 本轮选中/工具参数/指代结果 | 本轮结束 | L1 焦点 |
| `role_evidence` | string | system | derived | ephemeral | 解释 role 来源（连线方向、用户标注等） | — | L1 可选 |

**RoleTag（可扩展枚举）：**

```text
source_scene
reference_material
reference_style
generated_variant
unknown
```

规则：

- 多值集合；同一物件可同时 `generated_variant` + 本轮 `task_roles: [source_scene]`。  
- `task_roles` **不写回** `standing_roles`，除非用户确认。  
- 不得把 `pending`/`failed` 放进 roles。

### 5.3 结构 Structure

| 字段 | 类型 | 来源 | 权威 | 存储 | 更新 | 失效 | 层 |
|------|------|------|------|------|------|------|-----|
| `pose.x` `pose.y` | number | system | absolute | fact | move | — | L0 可粗网格化 |
| `pose.rot` | number | system | absolute | fact | rotate | — | 总览/几何用 |
| `pose.w` | number? | system | absolute | fact | resize | — | 几何用 |
| `grid` | `{gx, gy}` | geometry | derived | ephemeral | 由 pose 与格子尺寸计算 | pose 变 | L0 文本 `@(-2,1)` |
| `relative_hints` | `Derived<string>[]` | geometry | derived | ephemeral | 相对焦点：左/右/上/下/近（**产品决定不做**） | pose/selection 变 | （不做） |
| `edges_in` | `{connection_id, from}[]` | system | absolute | fact | 连线 CRUD | — | L0/L1 |
| `edges_out` | `{connection_id, to}[]` | system | absolute | fact | 连线 CRUD | — | L0/L1 |
| `lineage` | 见下 | system/generation | derived | ephemeral | 由 connections + 生成记录归纳 | 图变 | L1 |
| `cluster_id` | string? | geometry | derived | ephemeral | 运行时聚类 | pose 变 | L1 可选 |

**lineage（血缘摘要，派生）：**

```text
parents: artifact_id[]     // 入边 from
children: artifact_id[]    // 出边 to
// 语义提示（非强制枚举）：generated_from / references
```

**显式关系 vs 几何关系：**

| 种类 | 例子 | 存储 | 权威 |
|------|------|------|------|
| 显式 | `desk_state.connections` from→to | fact | absolute |
| 几何 | 左/右、相邻、重叠、同簇 | ephemeral 重算 | derived；**不自动升为领域事实** |

### 5.4 内容 Content

| 字段 | 类型 | 来源 | 权威 | 存储 | 更新 | 失效 | 层 |
|------|------|------|------|------|------|------|-----|
| `file_id` | string? | system | absolute | fact (payload) | 上传/生成完成 | 版本替换 | L0 有无图；L3 加载键 |
| `content_hash` | string? | system | absolute | fact (files) | 文件写入 | 文件替换 | 派生失效键 |
| `media_type` | string? | system | absolute | fact | 文件写入 | — | L3 |
| `original_filename` | string? | system/user | high | fact | 上传 | — | fallback 输入 |
| `intent.user_prompt` | string? | user/generation | high | fact (payload) | 生图/重试 | 新版本 | L2 Focus |
| `intent.composed_prompt` | string? | generation | derived | fact (payload.prompt) | 生图管线 | 新版本 | L2 审计；慎当画面事实 |
| `intent.origin` | `canvas_panel` \| `agent_chat` \| … | generation | absolute | fact | 生图 | — | L1 可选 |
| `intent.region` | box? | user | high | fact | 局部重绘 | 新版本 | L2/L3 inpaint |
| `intent.reference_file_id` | string? | user | high | fact | 局部重绘参考 | 新版本 | L2 |
| `visual.caption` | `Derived<string>` | vision | hint | **cache**（独立表/KV，**不进 artifact payload**） | 异步分析 | file hash / version / analyzer_version 变 → stale | L2 Focus |
| `visual.attributes` | `Derived<AttrMap>` | vision | hint | cache | 异步分析 | 同上 | L2 可选 |
| `visual.ocr` | `Derived<string>` | vision | hint | cache | 异步分析 | 同上 | L2 可选 |
| `pixels` | 图像字节/引用 | system | absolute（像素本身） | fact (files) | 文件 | — | **L3 only** |
| `pixels_available` | boolean | system | absolute | ephemeral | 有 file 且非 pending | — | L0/L1 调度 |

规则：

- **Intent 可完整进入 L2；不得写成「图上已是…」。**  
- **Caption 默认 hint**；用户确认后的 caption 可升为 `source=user` high（产品可选）。  
- **L3 未加载时**禁止声称已看清材质/比例/细节。

---

## 6. 关系级（DeskRelationWorld）

全桌关系列表（与物件上的 edges 对偶，便于 Survey 一块打印）：

| 字段 | 类型 | 来源 | 权威 | 存储 | 更新 | 失效 | 层 |
|------|------|------|------|------|------|------|-----|
| `connection.id` | string | system | absolute | fact | 创建 | 删除 | L0 |
| `connection.from` | artifact_id | system | absolute | fact | — | — | L0 |
| `connection.to` | artifact_id | system | absolute | fact | — | — | L0 |
| `connection.kind` | 可选枚举 | user/system | high/derived | fact 或 ephemeral | 未来可标 generate/reference | — | L1 |

现状：`DeskConnection` 仅 `id/from/to`，无 kind——目标态允许缺省，由方向与生成记录推断 lineage 文案。

---

## 7. 指代消解结果（ReferenceResolution）

非桌面持久字段；本轮 Task context 产物：

| 字段 | 类型 | 来源 | 权威 | 存储 | 层 |
|------|------|------|------|------|-----|
| `utterance` | string | user | high | ephemeral | — |
| `resolved_ids` | artifact_id[] | system | derived | ephemeral | 进入 Focus |
| `candidates` | `{id, reason}[]` | system | hint | ephemeral | 不唯一时 |
| `basis` | string | system | derived | ephemeral | 须写明命中字段 |
| `unique` | boolean | system | absolute | ephemeral | `false` 则禁止静默 |

消解优先级（目标）：

1. 显式 id / alias（A01）  
2. `display_name` 唯一命中  
3. `fallback_name` / `label` 唯一命中  
4. `standing_roles` / `task_roles` + 唯一  
5. 连线血缘（「上一版」「源图」）唯一  
6. vision caption 相似 → **仅候选，不静默**  

**不做：** 空间关系（「左边 / 右边」）相对焦点的 harness 消解（与 `relative_hints` 同，产品决定）。  

---

## 8. 层级投影：字段 → L0–L3

### L0 Survey 文本（默认每轮）

每物件至少：

```text
alias | artifact_id | artifact_type | label | lifecycle | grid | edges_in/out 摘要
```

桌面级：`revision` `current` `project` `selection` `connections[]` `jobs_summary`  
可选视觉：`overview_image` + `alias_map` + image index 表  

### L1 语义（默认或近默认）

- `standing_roles` / `task_roles`（非 stale）  
- `lineage` 父母子女  
- `relative_hints`（相对选中或全局简表）  
- `created_by` `intent.origin` 可选  

### L2 Focus（焦点 + 一跳邻接）

- `intent.*`  
- `visual.caption` / attributes（标 source + stale）  
- `original_filename` `version_no`  
- **不包含**全桌每个物件的 L2  

### L3 Inspect

- `pixels`（或 crop）  
- 明确 image index：`image_k = alias (artifact_id)`  
- 可与 L2 同屏，但像素是验收依据  

### 预算降级顺序（字段级）

超预算时丢弃顺序（先丢后留）：

1. 非焦点 L2 visual  
2. 非焦点 L1 relative_hints / cluster  
3. overview_image  
4. 非焦点 L1 roles  
5. 保留：全桌 L0 目录 + 焦点 L2/L3 + 焦点一跳 edges + revision 头  

---

## 9. 与现状事实源的映射

| 世界模型字段 | 今日来源 |
|--------------|----------|
| `artifact_id` type version payload | `artifacts` + `artifact_versions` |
| `pose` | `desk_state.objects` |
| `edges` | `desk_state.connections` |
| `file_id` filename hash | `payload.file_id` → `stored_files` |
| `intent.user_prompt` / composed | `payload.user_prompt` / `payload.prompt` |
| `lifecycle` | `pending` / `error` / `file_id` |
| `selection_ids` | WS prompt `selectedArtifactIds` |
| `display_name` | **无** |
| `visual.caption` cache | **无** |
| `revision` 显式头 | **无**（仅有 desk updatedAt） |
| `alias` / overview | **无** |
| `task_roles` | 部分隐含于 generate 的 source/refs | 

编译入口（概念）：`DeskSnapshot` + files 元数据 + caches + session selection → `DeskWorld`。

---

## 10. 禁止项（字段纪律）

- 把 prompt 当 identity name  
- 把 lifecycle 写进 roles  
- 把 caption 写入 artifact payload 充作不可变版本内容（缓存须独立且可失效）  
- 仅用 confidence 覆盖 user/system 字段  
- 无 `pixels` / 无 Inspect 记录时输出「已确认画面为…」类断言  
- 用历史 `DESK_CONTEXT` 覆盖 `current=true` 的存在性  
- 指代不唯一时静默单选  

---

## 11. 开放实现点（字段已定、表结构可后定）

| 项 | 说明 |
|----|------|
| `display_name` 落库位置 | artifact 列 vs 侧车表 |
| caption cache 键 | `(file_id, content_hash, analyzer_version)` |
| `revision` 算法 | 单调版本号 vs 内容 hash |
| `alias` 稳定性 | 仅单轮稳定 vs 跨轮尽量稳定 |
| connection.kind | 是否扩展 schema |
| overview 分辨率；触发已定为按需工具 | 产品预算 / 已拍板 |

---

## 12. 下游文档

1. **装配规则**：Survey/Focus/Inspect 触发、token/图张数/字节预算、失败降级 → [agent-desk-context-assembly.md](agent-desk-context-assembly.md)  
2. **黄金任务**：字段级断言（label 唯一、连线可见、stale 不采信、假 Inspect 禁止）→ [agent-desk-golden-tasks.md](agent-desk-golden-tasks.md)  
3. **实现切片**：编译器模块边界、与 `desk-status.ts` 演进关系  

---

## 13. 一句话

**世界模型字段 = 桌面/物件/关系/指代四类读模型；每字段有来源与权威；L0–L3 是投影切片而不是另一套数据；派生可错可过期，系统与用户事实不可被 vision 分数推翻。**
