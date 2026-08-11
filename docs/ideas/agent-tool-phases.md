# Agent 工具发现式加载（窄 base + 搜索 + wake 硬名单）

## 问题陈述

如何让桌面 Agent **默认不把全部工具塞进本轮上下文**，在需要时再发现并激活工具，同时：

- 不销毁会话历史  
- 策略文案与真实可调工具一致  
- JOB_EVENT 回注不会自动连环生图  
- 与 pi 的动态工具 / 工具搜索能力对齐  

以**预期架构**为准（能力会涨、上下文要瘦），不以「当前只有十来个工具」为借口长期全塞。

## 推荐方向

**全量注册 + 窄默认激活 + `search_tools` 发现式加载 + 每次激活变化重建 tool policy + wake 硬 allowlist（禁生图）。**

```text
全量 register / customTools（实现都在进程里）
  → 默认 active = 窄 base（含 search_tools）
  → 模型需要能力时 → search_tools → setActiveTools 打开匹配工具
  → 每次 active 变化 → policy 重建（文案只写当前能用的）
  → JOB_EVENT wake → 硬切 wake 名单（无生图 / 无删除；search 不可把生图搜回来）
  → 用户下一轮明确要求 → 再回窄 base，可再搜再生图
```

### 三个关键概念

#### 1. 窄 base（narrow base）

**每一轮默认给模型的工具集合，故意很少。**

建议默认包含：

| 工具 | 作用 |
|---|---|
| `search_tools` | 发现并激活其它已注册工具（必有） |
| `look_at` / `look_at_desk` | 看物件 / 看桌（高频、低破坏） |

可选是否进窄 base（产品定，MVP 建议**不进**，靠搜索打开，保持真·窄）：

- `generate_from_desk` / `text_to_image_on_desk` / `replace_on_desk`  
- `get_task`  
- memory 读写  
- `remove_from_desk`（更应收进搜索或 dangerous，默认不进 base）

「窄」= 少进本轮工具 schema / 策略上下文；**不是**从进程卸载实现。

#### 2. policy 重建（policy rebuild）

**system 里「有哪些工具、怎么用」的策略段，必须随当前 active 工具重写。**

原因（pi）：Qijian 使用 `DefaultResourceLoader({ systemPrompt: deskSystemPrompt(...) })`，走 **customPrompt** 路径。此时 `buildSystemPrompt` **直接返回 custom 全文**，**不会**按 `selectedTools` 注入 `toolSnippets` / `promptGuidelines`。

因此只调 `setActiveToolsByName` 会改「真能调用的工具」，**不会**自动改 system 里写死的全工具说明 → 出现「文案让用 generate、schema 里没有」或反向矛盾。

**每次 active 变化必须：**

1. `setActiveToolsByName(当前集合)`  
2. `buildToolPolicy(当前集合)` 写入/覆盖 system 的工具策略段（只描述 active 工具）

身份、不可信数据、记忆不变式等**稳定前缀**可固定（利于 cache）；**工具策略块**必须动态。

#### 3. wake 硬 allowlist（含禁生图）

**JOB 完成回注（`[JOB_EVENT]` / `[JOB_EVENT_BATCH]`）那一轮，用代码强制一份很短的工具白名单，不靠模型自觉。**

| 可开 | 不开 |
|---|---|
| `look_at` / `look_at_desk` | `generate_from_desk` |
| `get_task`（可选） | `text_to_image_on_desk` |
| memory **只读**（可选） | `replace_on_desk` |
| | `remove_from_desk` |
| | `search_tools`（推荐关掉，防止搜回生图） |
| | `record_project_memory`（可选关，避免回注时乱写记忆） |

**为何 wake 禁生图（仅回注轮，非永久）：**

- 回注任务是**汇报/验收**，不是再开生成  
- 防系统事件触发自动连环生图、烧额度、堆卡  
- 落实「失败禁止自动再调生图」「部分成功禁止整批重试」  
- 再生成必须等**用户明确要求**的新一轮（回到窄 base 后再 search / 调生图）

```text
用户：「出 3 版」→ search 激活生图 → 提交
  → 任务结束 → wake：只说明成败 / look_at（禁生图）
  → 用户：「第三张重试」→ 新一轮 base → 再 search → 再生图
```

### 与 pi 对齐的机制（有源）

| 能力 | 行为 | 来源 |
|---|---|---|
| 运行时激活 | `setActiveToolsByName` / `pi.setActiveTools` | pi `docs/extensions.md` |
| 工具搜索套路 | 全量注册；可搜索工具初始 inactive；保留 `search_tools`；匹配后 `setActiveTools` 打开 | 同上 dynamic / search_tools 段落（约 2314 行一带） |
| 生效时机 | **下一 agent turn** | `agent-session.d.ts` |
| customPrompt 短路 | 不自动按 active 过滤 tool guidelines | `dist/core/system-prompt.js` |
| 动态注册范例 | `registerTool` + `setActiveTools` | `examples/extensions/dynamic-tools.ts` |

Qijian 桌面工具经 `createAgentSession({ customTools })` 注册，等价于扩展侧的「已注册全集」；**自建 `search_tools`** 对 `getAllTools()` 做检索（关键词 / 标签 / 简单路由即可，MVP 不必上向量）。

### `search_tools` 行为（MVP）

**输入（建议）：** `query: string`（用户意图或能力关键词）

**输出：**

- 匹配到的工具名、一句话说明  
- 已执行：`setActiveTools(当前 active ∪ 匹配集)`（或替换策略，见下）  
- 提示：下一 turn 起可调用  

**检索范围：** 全部已注册桌面工具（含 debug 门控工具仅当 env 开启时出现在目录）

**激活策略（推荐）：**

- **累加激活**：`active = active ∪ matches`（本 run 内越用越多，直到会话 idle 或显式 reset）  
- **会话边界 reset**：新用户 turn 开始时先回到**窄 base**，再允许重新 search（避免上一轮搜出的删除/生图一直挂着）  
- **wake 例外**：进入 wake 时**强制覆盖**为 wake 名单，忽略此前累加  

**禁止：**

- 在 wake 档下通过 search 打开 generate / replace / remove  
- 未 search、未在 base 中的工具出现在 policy 文案中  

### 并行生图

- 发现并激活 `generate_from_desk` / `text_to_image_on_desk` 后，其 `executionMode: "parallel"` 仍然有效  
- 搜索**不**负责「一次出几张」；多路仍是同轮多次工具调用  
- `replace_on_desk` 保持 sequential  

## 待验证假设

- [ ] 窄 base + 先 search 再生图，对「出 3 个方向」的步数与成功率可接受  
- [ ] 每用户 turn reset 到窄 base，不会让多步对话过度重复 search  
- [ ] policy 只重建工具段时，模型仍遵守身份/记忆不变式  
- [ ] wake 关 search + 禁生图，能挡住连环生成  
- [ ] 历史里旧 tool_call 在工具已 inactive 时，不会 tool-not-found 死循环（必要时 steering）  
- [ ] search 的关键词匹配对中文意图足够（「出图」「删除」「记忆」等）

## MVP 范围

**做**

1. 全量 `customTools` 注册（与现 `createDeskTools` 对齐，含 `text_to_image`、debug 门控）  
2. 实现 `search_tools`（关键词匹配 `getAllTools` 元数据；`setActiveTools` 累加激活）  
3. 窄 base：`search_tools` + `look_at` + `look_at_desk`（MVP 固定这组，生图一律 search）  
4. `buildToolPolicy(activeNames)` + 每次 setActive 后重建工具策略段  
5. 用户 turn 开始：reset → 窄 base + policy  
6. `runJobWake` 前：强制 wake 名单 + policy；结束后（或下一用户 turn）回窄 base  
7. system 身份前缀去掉「写死全工具清单」；工具说明只来自 policy(active)  
8. 单测：  
   - 初始 active 不含 generate  
   - search「生图」后含 generate，policy 同步出现  
   - wake active 不含 generate / search（或 search 无法激活 generate）  
   - 未知 query 不乱开 remove  

**不做（MVP）**

- 向量 / 远程工具目录  
- 打开 pi skills 发现（保持 `noSkills: true`；搜索是自建 tool，不是 skill 包）  
- 每档位重建 `AgentSession`  
- 关键词 explore/generate/refine 互斥状态机（由 search + 窄 base 替代）  
- wake 自动重试生图  
- 设计师 HTTP batch 当 Agent 工具  

## 明确不做（及原因）

- **继续全量 active 塞进每轮上下文** — 与「默认要瘦」的预期相反，工具变多后不可持续  
- **只切 allowlist、不重建 policy** — customPrompt 下必矛盾  
- **wake 仍开生图或仍开可搜出生图的 search** — 系统事件易连环生成  
- **仅靠 prompt「不要调用 X」** — 不是硬边界  
- **用「现在工具少」否掉搜索** — 以现状衡量架构，偏离预期  

## 未决问题

- 窄 base 是否要把 `generate_from_desk` 直接放进默认（更少一步，但默认上下文更肥）— **MVP 文档定为不进，一律 search**；若 dogfood 摩擦过大再调  
- 用户 turn 是「每 turn reset base」还是「session 内累加直到 idle」— **MVP：每用户 turn reset**  
- `record_project_memory` 是否允许被 search 打开，还是仅成功生图后由规则打开  
- wake 是否保留 `get_task`  
- setActive 后覆盖 system 的具体 API（session 字段 / 扩展 before_agent_start / 自建 rebuild）相对当前 pi 版本的写法  

## 流程（参考）

```text
create(session)
  → customTools = 全部桌面工具 + search_tools
  → setActive(窄 base) + policy(窄 base)

用户消息（新 turn，空闲）
  → setActive(窄 base) + policy   // reset
  → session.prompt
  → 模型 search_tools("出效果图") 
  → setActive(base ∪ generate…) + policy
  → generate_from_desk ×N（parallel）
  → 返回 accepted；本 turn 结束

JOB_EVENT（空闲）
  → setActive(wake 硬名单) + policy(wake)  // 无生图、无 search 或 search 无效于生图
  → 说明成败 / look_at
  → 禁止自动 generate

用户：「第三张重试」
  → reset 窄 base → search → generate（仅失败项）
```

## 实现锚点

| 区域 | 路径 |
|---|---|
| 工具注册 | `apps/server/src/agent/tools/index.ts` |
| Session 创建 | `apps/server/src/agent/session-factory.ts` |
| Prompt / wake | `apps/server/src/agent/session-registry.ts` |
| 身份 system | `apps/server/src/agent/system-prompt.ts`（去掉全工具硬编码列表） |
| Wake 文案 | `apps/server/src/agent/async-job/job-event.ts` |
| 新建 | `search_tools` 工具 + `tool-policy.ts`（packs / policy 构建） |
| pi | `docs/extensions.md` setActiveTools / search 套路；`system-prompt.js` customPrompt 短路 |

## Doubt / 修订记录

- 初版：阶段 packs（explore/generate/refine）— 被否：多意图单轮、customPrompt C5、wake 未设计。  
- 二版：偏宽档位 base/wake/dangerous — 更安全，但**默认仍偏肥**，且未把发现式加载当主路径。  
- **本版（按预期）：** 窄 base + `search_tools` 为主；policy 重建；wake 硬名单且禁生图；以未来工具膨胀与瘦上下文为目标，不以「当前工具少」否掉搜索。  
- 跨模型：曾 skip。  

## 状态

**已实现（2026-08-11）：**

- `apps/server/src/agent/tools/tool-activation.ts` — catalog / 窄 base / wake / policy / applyToolActivation  
- `apps/server/src/agent/tools/search-tools.ts` — `search_tools`  
- `system-prompt.ts` — 仅身份前缀 `deskIdentityPrompt`（去掉全工具硬编码）  
- `session-factory.ts` — 全量 customTools + 初始窄 base  
- `session-registry.ts` — 用户 turn → 窄 base；system/wake → wake 硬名单  

验证：`npx vitest run apps/server/src/agent` 通过。
