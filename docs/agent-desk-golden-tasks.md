# Agent 桌面感知：黄金任务与验收

**状态：** 验收规格（非实现、非 ADR）  
**实现进度（2026-08-08）：** L-A 底座 + P0 夹具已落地。Caption：`image_captions` 表、Focus 注入、异步 vision 写（生图 complete / createPlaced / append ready）；读路径 80ms 超时 skip。**桌面总览：** 按需工具 `look_at_desk`（toolResult 内联 `role=desk_overview`，不算 Inspect；无 ready 像素整工具失败；**非**每轮默认注入 Survey）。**人用**画布左下 minimap 已落地（与 agent 总览解耦）。**GT-18（当前桌压历史）** L-A 夹具已落地：装配只认本轮 snapshot，`historyDeskMentions` 不入参；Survey 不得含已删 id。已做：单物件 `look_at(ids|alias)`。未做：几何「左边」（GT-11）、`relative_hints` 文本（产品决定不做）、GT-09/14–16/19–20 夹具与装配预算 report、Compare、L-B。GT-14/16 语义见任务注：默认 overview 已改为工具路径。  
**日期：** 2026-08-08  
**上游：** [agent-desk-perception-goals.md](agent-desk-perception-goals.md)、[agent-desk-world-model-fields.md](agent-desk-world-model-fields.md)、[agent-desk-context-assembly.md](agent-desk-context-assembly.md)  
**范围：** 用固定夹具断言「看见 / 指代 / 装配」是否正确  
**非范围：** 设计审美、文案质量、生图效果；那些另做产品评测

---

## 1. 验收原则

1. **夹具优先于手点 UI。** 主路径是纯函数：`DeskWorld` 编译 + 上下文装配（+ 可选指代消解）。  
2. **先测确定性层，再测模型层。** 装配与消解不依赖 LLM 也应能红绿。  
3. **断言结构化输出，不断言散文好不好。**  
4. **诚实优先。** 假 Inspect、假唯一指代、用历史桌面压当前 → 一律失败。  
5. **confidence 不作门闸。** 不得出现「分数高故采信」类逻辑被测成通过条件。

### 1.1 两层门闸

| 层 | 测什么 | 是否阻塞合并 |
|----|--------|--------------|
| **L-A 装配/消解** | 文本块、image index、resolved_ids、report.dropped | **是**（实现落地后） |
| **L-B 模型行为** | 真实/录制模型是否点对 id、是否假称看过 | 建议有，可抽样；不替代 L-A |

本文任务默认写 **L-A**；标注 `+L-B` 的条目在有模型评测时加跑。

---

## 2. 夹具格式（概念）

每条黄金任务一个夹具，逻辑字段：

```text
id: GT-xx
title: 短名
fixture:
  desk: DeskSnapshot 等价物（含 layout / connections / payload）
  files?: { file_id → { filename, mediaType, content_hash } }
  caches?: { captions?: Derived[] }
  selection_ids: string[]
  user_text: string
  attachments?: []
  budget?: 覆盖默认装配预算
  history_desk_blocks?: 可选，模拟旧 DESK 仍在 thread
expect:
  desk_header: { current: true, revision?: "present" }
  survey: { ... }
  focus?: { ... }
  inspect?: { ... }
  resolution?: { ... }
  assembly?: { dropped_includes?, dropped_excludes?, modes? }
  forbidden: string[]   # 输出中不得出现的模式（如假像素断言标记）
```

实现时可用 TS fixture + vitest；本文用可读表格描述同一语义。

### 2.1 共享场景「静安桌」S1

用于多数任务（id 固定，便于断言）：

| alias 预期 | artifact_id | type | lifecycle | label 信号 | 其它 |
|------------|-------------|------|-----------|------------|------|
| A01 | `art-living` | canvas_image | ready | 文件名 `客厅原图.jpg` | file `f-living` |
| A02 | `art-mat` | canvas_image | ready | 文件名 `浅橡木材质.png` | file `f-mat` |
| A03 | `art-fx1` | effect_image | ready | fallback 效果图序；intent「换暖光」 | file `f-fx1`；边 **A01→A03** |
| A04 | `art-pending` | effect_image | pending | — | 无 file；边 **A01→A04** |
| A05 | `art-empty` | canvas_image | empty | — | 无 file |

布局（世界坐标示意）：A01 (0,0)，A02 (400,0)，A03 (800,0)，A04 (800,200)，A05 (-400,0)。

---

## 3. 断言库（可复用检查点）

| 代号 | 断言 |
|------|------|
| H1 | 存在 DESK 块且含 `current=true` |
| H2 | 存在可比较的 `revision`（非空） |
| S1 | Survey 列出桌上全部 ready/pending/empty 物件（或截断规则内的焦点优先集） |
| S2 | 每件 L0 含：id（或 alias 可反查 id）、type、可区分 label、lifecycle |
| S3 | 同桌任意两件 `label` 不相同（或 label+alias 联合唯一） |
| S4 | 显式连线出现在连线表（如 living→fx1） |
| S5 | 无效 selection id 标为无效，且不进入有效 focus |
| F1 | `focus_ids` 核心物件有 L2 Intent 或「无 intent」显式缺失，而非静默当画面事实 |
| F2 | stale caption 不得以 fresh 口吻出现 |
| I1 | `inspect_ids` ⊆ 本轮 `images` 中 `role=inspect` 的 artifact_id |
| I2 | pending/empty 不在 `inspect_ids` |
| I3 | overview（若有）`role=desk_overview`，且 **不在** `inspect_ids` |
| I4 | 未 Inspect 的 id 不得出现在「已附原图」列表 |
| R1 | 唯一指代 → `unique=true` 且 `resolved_ids` 正确 |
| R2 | 不唯一 → `unique=false`，candidates 含正确项，**不**把错误 id 当唯一 |
| R3 | 仅 caption 相似不得 `unique=true` |
| B1 | 超预算时 report 含 dropped；焦点 L0 仍在 |
| B2 | Inspect 裁切优先级：selection > resolution > 其它 |
| X1 | snapshot 失败 → 降级 DESK 文案，无桌面 inspect 图 |
| C1 | 历史 `current=false`/旧 revision 不得覆盖本轮物件存在性（装配只认本轮 DESK） |

---

## 4. 黄金任务清单

### GT-01 空桌 Survey

| | |
|--|--|
| **桌** | 无物件 |
| **选中** | [] |
| **用户** | 「桌上有什么」 |
| **期望** | H1；Survey 含空桌；无 Focus 强制；无 Inspect 图 |
| **断言** | H1, S1（空） |
| **层** | L-A |

### GT-02 静安桌默认 Survey（无选中）

| | |
|--|--|
| **桌** | S1 |
| **选中** | [] |
| **用户** | 「先看看桌面」 |
| **期望** | 五件皆在目录；A01/A02 label 来自文件名可区分；A01→A03、A01→A04 在连线表；lifecycle 含 pending/empty/ready |
| **断言** | H1, H2, S1–S4 |
| **层** | L-A |

### GT-03 撞名禁止

| | |
|--|--|
| **桌** | 两张 canvas ready，文件名皆空或皆缺，仅靠序号 |
| **选中** | [] |
| **用户** | 「列一下」 |
| **期望** | 不得两行皆为「画布图」；须 `画布图-1`/`画布图-2` 或等价唯一 label |
| **断言** | S3 |
| **层** | L-A |

### GT-04 选中无效 id

| | |
|--|--|
| **桌** | S1 |
| **选中** | [`art-living`, `missing-id`] |
| **用户** | 「继续」 |
| **期望** | `missing-id` 标无效；有效 focus 仅 living；不因无效 id 崩溃 |
| **断言** | S5, H1 |
| **层** | L-A |

### GT-05 选中自动 Inspect

| | |
|--|--|
| **桌** | S1 |
| **选中** | [`art-living`, `art-mat`] |
| **用户** | 「这两张有什么区别」 |
| **配置** | `auto_inspect_selection=true` |
| **期望** | inspect 含 living+mat；pending/empty 不在；image index 可反查 alias |
| **断言** | I1, I2, I4, H1 |
| **层** | L-A；**+L-B** 模型须基于图而非臆造第三张 |

### GT-06 选中含 pending 不进 L3

| | |
|--|--|
| **桌** | S1 |
| **选中** | [`art-pending`, `art-living`] |
| **用户** | 「看选中」 |
| **期望** | Inspect 仅 living；pending 文本说明生成中、无原图 |
| **断言** | I2, I1 |
| **层** | L-A |

### GT-07 指代：材质唯一

| | |
|--|--|
| **桌** | S1；A02 label/filename 含「材质」 |
| **选中** | [] |
| **用户** | 「材质那张是什么」 |
| **期望** | `unique=true`，resolved=`art-mat`；可 Focus A02 |
| **断言** | R1, H1 |
| **层** | L-A；**+L-B** 回复不得指成 living |

### GT-08 指代：不唯一须候选

| | |
|--|--|
| **桌** | 两张 canvas，文件名 `材质A.png` / `材质B.png` |
| **选中** | [] |
| **用户** | 「材质那张」 |
| **期望** | `unique=false`；candidates 含两者；不静默单选 |
| **断言** | R2 |
| **层** | L-A |

### GT-09 指代：禁止仅 caption 唯一化

| | |
|--|--|
| **桌** | 两张 ready；无区分文件名；caption 一为「木地板特写」一为「木色客厅」 |
| **选中** | [] |
| **用户** | 「木的那张」 |
| **期望** | 不得因 caption 单独 `unique=true`；应候选或追问 |
| **断言** | R3, R2 |
| **层** | L-A |

### GT-10 指代：血缘「源图」

| | |
|--|--|
| **桌** | S1；用户点名效果图语境 |
| **选中** | [`art-fx1`] |
| **用户** | 「源图是哪张」 |
| **期望** | resolved 含 `art-living`（入边 from）；basis 含连线/血缘 |
| **断言** | R1 |
| **层** | L-A |

### GT-11 指代：空间「左边」相对选中

| | |
|--|--|
| **桌** | S1 布局 |
| **选中** | [`art-fx1`]（x=800） |
| **用户** | 「左边那张」 |
| **期望** | 在几何规则下唯一消解到更近左邻（如 mat 或 living，**夹具写死期望 id**）；不唯一则 R2 |
| **断言** | R1 或 R2（夹具固定一种布局使唯一） |
| **层** | L-A |
| **注** | 实现几何前可标 `pending-impl`，但规格保留 |

### GT-12 Focus 含 Intent 且不冒充画面

| | |
|--|--|
| **桌** | S1 |
| **选中** | [`art-fx1`] |
| **用户** | 「这张当时想生成什么」 |
| **期望** | Focus 出现 intent「换暖光」类；不得写成「图上一定是暖光」的事实句式（L-A 可断言 Intent 字段存在；L-B 断言措辞） |
| **断言** | F1 |
| **层** | L-A；**+L-B** |

### GT-13 stale caption

| | |
|--|--|
| **桌** | A01 ready；caption cache `derived_from.content_hash` 与当前 file 不符 → stale |
| **选中** | [`art-living`] |
| **用户** | 「描述这张」 |
| **期望** | 不输出未标记的 stale 文案当 fresh；可省略或标过期 |
| **断言** | F2 |
| **层** | L-A |

### GT-14 预算：砍 overview 保焦点

| | |
|--|--|
| **桌** | S1 + 额外 30 张 ready 占位（短 payload） |
| **选中** | [`art-living`] |
| **预算** | 极低 text + 禁止大图 或 `max_images=1` 仅够 inspect |
| **期望** | living 完整 L0（+ 宜有 Inspect）；overview 可 dropped；report 记录 |
| **断言** | B1, B2, H1 |
| **层** | L-A |
| **注** | 产品已定总览为**按需** `look_at_desk`，非每轮 Survey 注入。本 GT 原「默认 overview 可 drop」语义可标 `superseded`；保留则改为：不自动塞 overview；工具超时/失败 = 无 overview 图，焦点 L0/Inspect 优先。 |

### GT-15 预算：Inspect 张数裁切

| | |
|--|--|
| **桌** | 6 张 ready |
| **选中** | 6 张全选 |
| **配置** | `max_inspect_images=4` |
| **期望** | 仅 4 张进 inspect；其余声明未附原图；优先前 4 个 selection 顺序 |
| **断言** | B2, I4 |
| **层** | L-A |

### GT-16 overview 不算 Inspect

| | |
|--|--|
| **桌** | S1 |
| **选中** | [] |
| **配置** | 助手调用 `look_at_desk`（或测试夹具注入 `role=desk_overview`） |
| **期望** | desk_overview **不在** `inspect_ids`；不得凭总览做材质/比例/验收断言 |
| **断言** | I3 |
| **层** | L-A |
| **注** | 与实现一致：总览在 toolResult 内，与用户轮 `[INSPECT]` / `image_N` 编号隔离。 |

### GT-17 snapshot 失败

| | |
|--|--|
| **桌** | 读取抛错 |
| **选中** | [] |
| **用户** | 「看看桌」 |
| **期望** | 降级文案；无 desk inspect 图；进程不崩 |
| **断言** | X1, H1（current=true 仍建议带） |
| **层** | L-A |

### GT-18 当前桌压过历史

| | |
|--|--|
| **桌** | 本轮 S1 **无** A02（已删材质） |
| **history** | 旧消息含含 A02 的 DESK 叙述 |
| **选中** | [] |
| **用户** | 「材质还在吗」 |
| **期望** | 本轮 Survey **无** art-mat；装配不把历史 id 注入当前目录 |
| **断言** | C1, S1 |
| **层** | L-A；**+L-B** 模型应以本轮 DESK 为准答「不在」 |

### GT-19 Compare 两效果图

| | |
|--|--|
| **桌** | living + fx1 + fx2（两效果图皆自 living） |
| **选中** | [fx1, fx2] |
| **用户** | 「对比这两个哪个更暖」 |
| **期望** | Compare 表含两行；宜 Inspect 两者或声明未附图；不得引入第三张当已看 |
| **断言** | I1, I4, H1 |
| **层** | L-A；**+L-B** |

### GT-20 改图任务升采样（集成意图）

| | |
|--|--|
| **桌** | S1 |
| **选中** | [] |
| **用户** | 「按材质那张改客厅」 |
| **期望** | 消解 mat + living（或 mat 唯一 + living 由「客厅」消解）；Focus 两者；宜 Inspect 两者备改图；连线上下文保留 |
| **断言** | R1（可多 id）, F1, I2 |
| **层** | L-A；**+L-B** 工具 source/ref 不得反 |

---

## 5. 执行方式

### 5.1 L-A（合并门禁，实现后）

```text
vitest: assemble(fixture) → expect(assertions)
```

- 不启真实 LLM。  
- 图像可用 1×1 PNG 或 mock loader。  
- 每条 GT 对应 `tests/agent/desk-golden/GT-xx.*`（路径实现时定）。

### 5.2 L-B（抽样）

- 同一夹具装配结果 + 固定 system 纪律 → 调模型或回放。  
- 评分：结构化（是否输出正确 id / 是否调用 look）优先；可用 LLM-as-judge 仅作辅。  
- 失败不自动当 flaky 忽略；记录 trace。

### 5.3 与 CI

| 阶段 | CI |
|------|-----|
| 仅有文档 | 不跑 |
| 装配器落地 | L-A 全量必过 |
| 有模型键 | Nightly L-B 子集（GT-05,07,18,20） |

---

## 6. 优先级（实现排序建议）

| 批次 | 任务 | 原因 |
|------|------|------|
| P0 | GT-01,02,03,04,17 | Survey 底座与健壮性 |
| P0 | GT-05,06,16 | Inspect 诚实 |
| P1 | GT-07,08,09,10 | 指代 |
| P1 | GT-12,13,18 | Intent/stale/当前性 |
| P2 | GT-11,14,15,19,20 | 几何、预算、对比、闭环 |

---

## 7. 通过标准

- **文档阶段：** 任务被评审同意，无「无法客观断言」的条目（GT-11 可暂 `pending-impl`）。  
- **代码阶段：** P0 L-A 全绿才可宣称「桌面感知装配达标」。  
- **不得**用「模型有时能答对」替代 L-A 绿。

---

## 8. 一句话

**黄金任务 = 固定静安式桌面夹具 + 对装配/指代输出的硬断言；先保证机器看见对，再抽测模型是否遵守看见结果。**
