# Agent 设计对照：现状、前沿与路线

**状态：** 调研结论（供决策，非 ADR）  
**日期：** 2026-08-06  
**范围：** 从 Agent 架构视角审视砌间设计桌面；对照 2025–2026 主流实践与《深入理解 AI Agent》（李博杰），给出分阶段路线。  
**相关：** [ADR 0012](adr/0012-agent-analysis-only.md)、[画布工作台设计](canvas-workbench-design.md)、[后端重写设计](implementation/agent-backend-redesign.md)、[核心 skill 与场景适配器](adr/0003-core-skill-with-domain-adapters.md)

---

## 1. 一句话

控制面已是「可行动 Agent」骨架；能力面被 ADR 0012 收成「分析 + 附件 + 对话」。  
产品目标是画布循环（选图 → 指令 → 新图落桌 → 再改）。  
下一步应补 **desk 上下文 + 最小写桌 ACI**，而不是上 multi-agent。

---

## 2. 我们现在是什么

### 2.1 控制面（已成型）


| 组件                                     | 职责                                                 |
| -------------------------------------- | -------------------------------------------------- |
| `ChatGateway`                          | WebSocket 收 prompt/stop，广播 agent 事件                |
| `AgentSessionRegistry`                 | 每项目/线程一个 session；30min idle 回收；run 队列              |
| `SessionFactory`                       | 嵌入 `@earendil-works/pi-coding-agent`；compaction 开启 |
| pi `SessionManager.continueRecent`     | 按 thread JSONL 持久化模型上下文（含 tool 轨迹）               |
| `agent-event-persister`                | tool 起止与 assistant 文本落库                            |
| `createDeskTools` / `generate_from_desk` | 写桌 ACI（ADR 0013）；tool 事件落产品 DB                     |


技术选型要点：

- SDK **同进程**嵌入，非 RPC 子进程  
- 文本 LLM 走 pi `ModelRuntime`；图像走独立 `ImageGenerator`  
- Artifact 版本化与 `desk_state` 布局分离（内容 ≠ 位置）

### 2.2 能力面（刻意收窄）

见 ADR 0012：

- Agent 作用域 = **分析 + 附件 + 对话**  
- 不调用任何写桌面工具  
- Artifact 类型仅 `sticky_note` / `canvas_image`  
- 不再用「工具暂时为空、将来恢复」的含糊措辞

### 2.3 产品目标（画布工作台）

见 `docs/canvas-workbench-design.md`：

```
图放桌上 → 点选 → AI 出图落回旁边 → 再选再改
对话是嘴，画布是场地
```

成功标准是「新图是否正确落桌并可再迭代」，不是「回复是否像设计师」。

### 2.4 核心张力


| 层             | 状态                                            |
| ------------- | --------------------------------------------- |
| 基础设施          | 可行动 Agent 骨架（session / 事件 / tool 持久化 / 写路径依赖） |
| 当前语义          | 分析 chatbot（无工具、不读桌）                           |
| System prompt | 仍自称「桌面行动者」，与 ADR 0012 不一致                     |
| 产品叙事          | 画布循环需要选中进上下文 + 结果写回桌                          |


---

## 3. 前沿共识（2025–2026）

### 3.1 主要来源


| 来源                                                                                                                     | 关键结论                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [Anthropic: Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents)                | 先简单；区分 Workflow 与 Agent；**工具接口（ACI）比 prompt 更重要**                                     |
| [Cognition: Don’t Build Multi-Agents](https://cognition.ai/blog/dont-build-multi-agents)                               | **Context engineering 是第一工作**；动作携带隐式决策；写路径并行会互相打架                                     |
| [Anthropic: Multi-agent Research](https://www.anthropic.com/engineering/built-multi-agent-research-system)             | Multi-agent 适合**广度只读**；写 + 共享状态差；token 成本约 15× 聊天                                     |
| [Anthropic: Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) | 技能 = 渐进披露的领域知识文件夹；按需加载，不塞满 system prompt                                              |
| LangChain 归纳                                                                                                           | read-multi 易、write-multi 难；需要 durable execution 与 eval                                |
| 李博杰《深入理解 AI Agent》v1.2（2026-07）                                                                                        | **Agent = LLM + 上下文 + 工具**；Harness / Loop 工程；KV cache 友好布局；状态栏；proposer–reviewer；评估驱动 |


### 3.2 可直接采用的原则

1. **Share context** — 每个动作应能看到相关决策历史；理想情况共享完整 agent trace。
2. **Actions carry implicit decisions** — 落图位置、风格、采用哪张图都是决策；冲突决策 → 坏结果。
3. **Write 密集任务用单线程主 Agent** — 设计桌是写密集（改桌面状态），不要拆多个写 agent 并行。
4. **Read 可并行** — 资料调研、风格参考检索可 subagent；**禁止**并行写同一 desk。
5. **ACI 优先** — 工具名、参数、错误信息按「模型是否好用」设计，等同 HCI 投入。
6. **Skills 承载领域知识** — 家装节奏、材料语言 progressive disclosure，而不是硬编码 6 阶段关卡。
7. **先 eval 再复杂化** — 约 20 条真实任务即可起步；LLM-as-judge + 人工抽检。
8. **Harness &gt; 换模型** — 竞争力在 loop（工具稳定、幻觉、越权、假成功），不在单纯更大模型。
9. **KV Cache 友好是架构约束** — 稳定前缀（system + 工具定义）尽量不动；动态状态放轨迹末尾 meta，避免每轮改写 system 前缀。
10. **交付件可验证才算完成（proposer–reviewer）** — 用 Artifact / 工具结果判定「做完了」，禁止模型凭感觉自称已落桌。

### 3.3 明确不建议默认采用的

- 默认 multi-agent 编排（AutoGen / Swarm 式「多角色互相聊天」）  
- 把「出图 agent / 布局 agent / 便签 agent」拆成并行写桌  
- 为 multi-agent 先上重框架，再补业务工具  
- 用阶段关卡代替画布循环（已在画布设计中砍掉）  
- 把动态 desk/选中状态写进 system 前缀导致缓存反复失效

---

## 4. 书本对照：李博杰《深入理解 AI Agent》

**来源：** 李博杰，《深入理解 AI Agent：设计原理与工程实践》，v1.2，2026-07-21（约 309 页）。  
**立场：** 实践在前、命名在后；Skill / harness / loop engineering 是事后提炼，不是跟风名词。作者业务（Pine 长程高风险任务）倒逼出与 Anthropic/Cognition 同向的原则。

### 4.1 核心公式与全书地图

> **Agent = LLM + 上下文 + 工具**（大脑 + 眼睛 + 手脚）  
> RL 映射：Policy / Observation Space / Action Space。


| 部分  | 章    | 主题                                        | 对砌间相关度        |
| --- | ---- | ----------------------------------------- | ------------- |
| 基础  | 1    | 公式、ReAct、**Harness**、工作流 vs 自主            | 高             |
| 支柱  | 2–3  | 上下文工程（KV cache、Skills、**状态栏**、压缩）、记忆与 RAG | 高             |
|     | 4–5  | 工具设计、异步事件、Coding Agent                    | 高（工具章）        |
|     | 6–7  | **评估**、可观测、SFT/RL 后训练                     | 高（评估）；后训练暂缓   |
| 进阶  | 8–10 | 自我进化、多模态/Computer Use、多 Agent             | 中（多 Agent 谨慎） |


**优先阅读：** 第 1、2、4、6 章；写桌前加读 2.5 Skills、2.6 状态栏、4.2 工具原则。

### 4.2 书中可直接落地的机制


| 机制                | 书中要点                                 | 砌间映射                                               |
| ----------------- | ------------------------------------ | -------------------------------------------------- |
| Harness / Loop 工程 | 管工具不稳、幻觉、危险/越权操作、指令不遵循               | 已有 session/事件/run；差 desk 观察与写桌闭环                   |
| 上下文 = 能力上限        | 模型「看不见」的东西等于不存在                      | 当前无 desk/选中 → 眼睛被蒙住                                |
| KV Cache 友好       | 稳定前缀 + 动态内容后置；缓存是架构约束                | system/工具定义固定；选中与桌面摘要走末尾 meta                      |
| Agent Skills      | 渐进披露；元数据常驻、正文按需；注意第三方 Skill 注入面      | 打开 `noSkills`；家装/桌面 skill（对齐 ADR 0003）             |
| Agent 状态栏         | 轨迹末尾注入任务进度、环境与工作状态                   | **选中 ids、desk 摘要、run 状态** 放 status bar，不塞 system 头 |
| 提议者–审核者           | 审阅自己的 **artifact**，由验证决定结束，防假成功/过早放弃 | 出图/落桌后对照源图与工具结果再收口；Artifact 版本天然可审                 |
| 工具 ACI            | 粒度、描述、参数保真；专用工具 vs Skill+通用执行器       | Phase 1 少而清晰的写桌工具                                  |
| 评估驱动              | 没有评估就没有进步；约小样本即可起步                   | Phase 3 黄金任务 + 幻觉写桌                                |
| 多 Agent           | 共享写状态易并发冲突与错误级联                      | 单主 agent 写桌；只读调研才可隔离子 agent                        |


### 4.3 书 vs 砌间对照表


| 书中概念              | 砌间现状                     | 建议动作                   |
| ----------------- | ------------------------ | ---------------------- |
| LLM（大脑）           | pi + 可配置模型               | 先 harness，不先换模型        |
| 上下文（眼睛）           | 聊天 + 附件；无 desk/选中        | Phase 0：选中 + 桌面摘要（状态栏） |
| 工具（手脚）            | `generate_from_desk` 已接 | 可再扩读桌 / 便签等 ACI     |
| Skills            | `noSkills: true`         | Phase 2：家装 skill 渐进加载  |
| 状态栏               | 无                        | 末尾 meta：选中 / 桌面 / 进度   |
| Proposer–reviewer | Artifact 契约在，agent 不写    | 写桌恢复后以工具结果+版本为完成条件     |
| 评估                | 单元测试为主                   | ~20 黄金任务 + 假成功检测       |
| Multi-agent       | 未做                       | 默认不做；仅只读隔离             |


### 4.4 与本文路线的一致性

书的主线（Harness + 上下文工程 + 可验证交付件 + 评估）与本文 Phase 0→3 **同向**。  
书额外补强三点，已并入路线：

1. **状态栏注入**（比把 desk 写进 system 更正确）
2. **KV cache 布局纪律**
3. **proposer–reviewer 收口**（与 Artifact 一等公民对齐）

---

## 5. 对照：强项与缺口

### 5.1 已对齐


| 点                        | 说明                                          |
| ------------------------ | ------------------------------------------- |
| 单 Agent 主路径              | 符合 Cognition / 书第 10 章：写桌面不能多 agent 各自改     |
| 同进程 SDK + 事件流            | 工具结果可作为 ground truth 闭环（Harness 基础）         |
| Artifact 版本 + desk_state | 内容与布局解耦，动作可审阅（proposer–reviewer 的交付件）       |
| 工具注册边界                   | `createDeskTools` / `createToolContext` 骨架在 |
| Compaction + 历史视觉限流      | 初步 context 工程                               |


### 5.2 缺口


| 缺口               | 现状                       | 前沿 / 书 / 产品期望                  |
| ---------------- | ------------------------ | ------------------------------ |
| Desk 不在 context  | Agent 看不到选中物件与桌面快照       | 状态栏注入「当前选中 + 邻近物件摘要」           |
| 写工具仍窄           | 仅 `generate_from_desk`  | 可再扩读桌 / 便签 / 多源落图             |
| Skills 关闭        | `noSkills: true`         | 家装 skill 渐进加载（对齐 ADR 0003）     |
| Prompt 与 ADR 不一致 | 自称行动者但无工具                | 无工具只分析；有工具再切行动者语义              |
| 无 Agent eval     | 仅有单元测试                   | 20 条黄金任务 + 幻觉写桌 / 假成功检测        |
| 选中不进 prompt      | 前端选中未进入 agent            | 「选中 = 本轮输入」为一等上下文              |
| 无状态栏通道           | 动态状态无处安放                 | 轨迹末尾 meta，避免污染 system 前缀       |
| 长任务断点            | 模型上下文已 pi JSONL resume；长生图仍同步堵 loop | 出图需 pending 先推 / 可中断（见 harness H3） |


---

## 6. 推荐目标架构

```
┌──────────────────────────────────────────────────────────────┐
│  单线程 Desk Agent（主）                                       │
│  稳定前缀：system + 工具定义 + skill 元数据（KV cache 友好）   │
│  动态末尾：状态栏（选中 + desk 摘要 + run）+ 用户消息 + 附件   │
│  tools：读桌 / 写图落桌 / 便签 / 出图                          │
│  收口：proposer–reviewer（工具结果 + Artifact 版本可验证）     │
└────────────────────────────┬─────────────────────────────────┘
                             │ 仅「只读调研」时可选
                             ▼
┌──────────────────────────────────────────────────────────────┐
│  可选 Subagent（只读，隔离上下文）                             │
│  例：参考图风格调研、材料知识检索                               │
│  禁止并行写同一 desk                                           │
└──────────────────────────────────────────────────────────────┘
```

主 agent 内部可用 **workflow 片段**（仍是单 agent，不是多 agent）：

- **Prompt chaining：** 理解选中图 → 构造生成 prompt → 调图像模型 → 落桌  
- **Proposer–reviewer：** 出图后对照源图 / 约束 / 工具结果，再决定是否落桌或重试

多方向候选时：并行生成多个**候选文件**，由主 agent **统一**落桌比较（写仍单点）。

---

## 7. 分阶段路线

### Phase 0 — 诚实对齐 + 状态栏（低成本）

目标：语义一致，验证「对话挂在选区上」；建立 KV cache 友好的动态注入通道。

- [ ] 改 `deskSystemPrompt`：与 ADR 0012 一致；或明确「工具恢复后切换」  
- [ ] 前端 `selectedArtifactIds` 随 prompt 带上  
- [ ] **状态栏**注入只读 desk 摘要（物件 id / kind / 简短描述 + 当前选中）；放轨迹末尾 meta，不改 system 前缀  
- [ ] 验收：设计师说「这张图」时，agent 能指到具体 artifact  

**仍不写桌。**

### Phase 1 — 最小可行动 ACI（产品闭环）

目标：打通「选图 → 说改什么 → 新图落桌」。

建议工具（少而清晰）：


| 工具                   | 作用               | 设计要点                                  |
| -------------------- | ---------------- | ------------------------------------- |
| `list_desk`          | 读桌               | 返回 id/kind/摘要，不塞全量 base64             |
| `get_object`         | 读单物件             | 含版本、input_refs                        |
| `place_canvas_image` | 图落桌              | 强制 `near: source_artifact_id` 或显式 x,y |
| `generate_image`     | 调 ImageGenerator | 输入 = 选中图 + 文本；输出 file → place         |
| `upsert_sticky_note` | 便签               | 可选，非主路径                               |


ACI 原则：

- 参数名对模型友好（`source_artifact_id` 优于模糊 `context`）  
- 错误信息可行动（「Artifact 不属于当前项目」）  
- 写后 `object_changed` 推前端，形成 ground truth  
- 无工具时**禁止**声称已改桌（已有 prompt 纪律，需用 eval 盯住）  
- **完成条件 = 工具成功 + Artifact 版本可查**，不是 assistant 文案自称（proposer–reviewer）

引入写工具时 **另开 ADR**（ADR 0012 已预留），并补回所需 Artifact 类型（如 `effect_image`）的 payload 与 UI。

### Phase 2 — Context + Skills

- [ ] **Selection-as-context** 稳定化（选中变更即时反映到状态栏）  
- [ ] 打开或自建 Skills 加载（替代永久 `noSkills: true`）  
- [ ] Desk / 家装 skill 分层：  
  - L1：name + description（常驻，可放 meta 列表）  
  - L2：提案节奏、方向比较规则（按需加载）  
  - L3：材料 / 灯光参考按需读
- [ ] Skill 描述写清**反例**（何时不要触发），避免误路由  
- [ ] ADR 0003 的 domain adapter 优先落成 skill，而不是硬编码阶段机  
- [ ] 第三方 / 外部 skill 安装前审查（提示注入面）

### Phase 3 — 可靠与可测

- [ ] 约 20 条黄金任务（空桌说话、选图改材质、多轮迭代、PDF 户型分析）  
- [ ] 判据：是否幻觉写桌、结果是否落在源图旁、是否误改未选物件、是否假成功  
- [ ] 长任务：出图 run 可 resume；失败从 tool 边界重试  
- [ ] 生产 trace：按 run 可回放 tool 参数与结果（隐私前提下）  

### Phase 4 — 谨慎扩展（可选）

- 只读 research subagent（风格 / 竞品；隔离上下文，对齐书「隔离优于压缩」）  
- 多方向 sectioning / voting：并行候选文件 → 主 agent 统一落桌  
- **默认不上** multi-agent 编排框架

---

## 8. 关键判断（决策用）

1. **产品是 canvas agent，不是 chat agent。**  
 指标看落桌与再迭代，不看文案像不像设计师。
2. **Context engineering / Harness &gt; 换模型。**  
 选中图 + desk 摘要 + 工具结果 + 状态栏，优先于更大参数模型。
3. **写桌 = 决策。**  
 布局、风格、采用哪张图都必须在单线程可见历史中完成。
4. **空工具是正确收缩，不是终态。**  
 ADR 0012 清掉占位是对的；下一步是有意识设计最小工具集，而不是恢复旧 6 阶段流水线工具。
5. **Skills 比硬编码 workflow 更贴自由画布。**  
 画布不要关卡；领域知识用 skill 渐进加载，流程由人 + 选区驱动。
6. **可验证交付件决定任务结束。**  
 Artifact / 工具结果是 ground truth；禁止「感觉做完了」。
7. **动态状态走状态栏，稳定指令走 system。**  
 保护 KV cache 前缀，降低成本与延迟抖动。

---

## 9. 建议的「下一刀」

只做一件事先验证：

> **Selection-aware 分析 Agent（状态栏版）**  
> 前端把 `selectedArtifactIds` 随 prompt 带上 → 轨迹末尾状态栏注入 desk 摘要与选中图视觉 → 仍无写工具，但回复能指着桌上具体物件说话。

验收通过后，再开 ADR 进入 Phase 1 写桌 ACI。

---

## 10. 非目标（本文档）

- 不规定具体图像模型供应商  
- 不重做提案包导出 / 确认关卡  
- 不设计 multi-agent 消息协议  
- 不替代 ADR；落地写桌能力时另写 ADR  
- 不展开 SFT/RL 后训练与语音/机器人（书第 7、9 章，当前产品非优先）

---

## 11. 参考

- Anthropic, *Building effective agents* (2024-12)  
- Cognition, *Don’t Build Multi-Agents* (2025-06)  
- Anthropic, *How we built our multi-agent research system* (2025-06)  
- Anthropic, *Equipping agents for the real world with Agent Skills* (2025-10)  
- 李博杰，《深入理解 AI Agent：设计原理与工程实践》v1.2（2026-07-21）  
- 本仓库：`apps/server/src/agent/*`、`docs/adr/0012-agent-analysis-only.md`、`docs/canvas-workbench-design.md`

