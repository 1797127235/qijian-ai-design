# Agent Harness 审计

**状态：** 调研结论（供决策，非 ADR）  
**日期：** 2026-08-06（H1 落地：2026-08-07）  
**范围：** `apps/server/src/agent/*` 与对话 WS 相关前端；只谈 **Harness（基础设施）**，不谈新业务功能清单。  
**相关：** [agent-design-frontier-review](agent-design-frontier-review.md)、[ADR 0012](adr/0012-agent-analysis-only.md)、[ADR 0013](adr/0013-agent-generate-from-desk.md)、Phase 0/1 specs under `docs/superpowers/specs/`

---

## 1. 一句话

能力面已有第一刀（选中进上下文 + `generate_from_desk` 写桌）；  
**Harness = 让 Agent loop 可靠的外壳**，当前是「能跑」多于「跑稳」。  
**H1 已还：** 模型上下文走 pi JSONL 持久化，不再自搓 DB 重灌。  
**H2 已还：** prompt 结束后按本 run 工具业务结果收口（`fail()` → run `failed`）。  
剩余优先：长工具不堵（H3）。

---

## 2. 什么是 Harness

| 层 | 定义 | 本仓库例子 |
|----|------|------------|
| **业务能力** | Agent 会干什么 | 状态栏、chip、`generate_from_desk`、桌面 `object_changed` |
| **Harness / 基础设施** | loop 如何稳定、可恢复、可观测、可验收 | session 池、run/tool 落库、WS、失败语义、超时/中断、上下文恢复、eval |

书里（李博杰《深入理解 AI Agent》）与 Anthropic 实践里的 **Harness / Loop 工程**：管工具不稳、幻觉、越权、指令不遵循、长程状态——**不是换更大模型**。

---

## 3. 模块地图（现状）

```
ChatGateway (WS 协议 / run 起止)
    → AgentSessionRegistry (session 池 / idle / 本轮选中)
        → SessionFactory (pi createAgentSession + 事件订阅)
            → tools/*          手脚（generate_from_desk）
            → desk-status      当轮桌面状态栏
            → SessionManager.continueRecent  pi JSONL（按 thread 目录）
            → agent-event-persister  tool 起止落库（产品侧 UI/审计）
```

| 层 | 路径 | Harness 职责 |
|----|------|----------------|
| 入口 | `chat-gateway.ts` | 校验、ack、finishRun |
| 会话 | `session-registry.ts` / `session-factory.ts` | 池化、prompt 组装、工具注入 |
| 模型上下文 | `session-paths.ts` + pi `SessionManager` | durable loop / tool 轨迹 |
| 当轮桌面 | `desk-status.ts` | 本轮看见什么 |
| 手脚 | `tools/*` | ACI + 写桌副作用 |
| 可观测 | `agent-event-persister.ts` + chat runs | 事后能否复盘 |
| 前端通道 | `src/lib/api/chat-socket.ts` / `useChatSession` | WS 连接与重连 |

### 双账本（刻意分离）

| 账本 | 存哪 | 给谁 |
|------|------|------|
| **模型上下文** | `data/agent-sessions/{projectId}/{threadId}/*.jsonl`（pi） | LLM：user / assistant(toolCall) / toolResult 全树 |
| **产品聊天** | Postgres `chat_messages` / `chat_runs` / `chat_tool_calls` | 前端历史、审计、run 状态 |

不要再用 DB 聊天文本「假恢复」模型 session。

---

## 4. 已有基础（保留）

1. **Run + tool call 落库**（start/finish tool，产品侧）  
2. **EventWriteTracker**：prompt 结束前可 await 写库  
3. **Idle 回收 + stop/abort**  
4. **用户原文与状态栏分离**（状态栏不进 `chat_messages` 正文）  
5. **单写桌工具 + `object_changed`**（ADR 0013）  
6. **WS 断线重连**（开发热重启后可恢复连接，不清消息）  
7. **Compaction 开启**  
8. **pi session 持久化（H1）**：`SessionManager.continueRecent(cwd, agentSessionDir(project, thread))`；进程/idle 后再开同一 thread 带回完整 tool 轨迹  

这些是 harness 骨架，后续债应 **补强而非推倒**。

---

## 5. 核心问题（按严重度）

### 5.1 P0 — 直接伤产品信任

| ID | 问题 | 现状 | 后果 |
|----|------|------|------|
| **H1** | ~~Session 只在内存~~ | **已解决（2026-08-07）** | 见 §5.1.1 |
| **H2** | ~~Run 完成语义过粗~~ | **已解决（2026-08-07）**：`summarizeRunTools` + tool 落库认 `details.ok===false` | 见 §5.1.2 |
| **H3** | 长工具堵死整轮 | `generate` 同步等到约 120s | 体感挂死、WS「已离线」、pending 难中途展示 |
| **H4** | ~~历史上下文残缺（模型侧）~~ | **随 H1 关闭**：模型权威上下文 = pi JSONL，不再 DB 残缺重灌 | 产品侧聊天仍可不含 tool 块（UI 另议） |

#### 5.1.1 H1 落地说明

| 项 | 内容 |
|----|------|
| **改前** | `SessionManager.inMemory()` + 自搓 `session-restore`（只灌 user/assistant 文本） |
| **改后** | pi `continueRecent`；路径 `data/agent-sessions/{projectId}/{threadId}/` |
| **删除** | `session-restore.ts`（`loadHistoricalVisuals` / `restoreChatMessages`） |
| **保留** | `agentPrompt`（仅当轮附件格式化）→ `agent-prompt.ts` |
| **测试** | `session-persist.test.ts`：写 tool 轨迹 → 新 manager reopen → 读回 `toolResult` |
| **注意** | pi 在出现 **assistant** 之前不落盘；仅 user、无回复时崩溃仍会丢当轮（正常对话有 assistant 即落盘） |

#### 5.1.2 H2 落地说明

| 项 | 内容 |
|----|------|
| **改前** | `sessions.prompt` 不抛错 → 一律 `finishRun("completed")`；tool 只看 pi `isError` |
| **改后** | `persistToolEvent` 用 `isToolBusinessFailure`（对齐前端）；`summarizeRunTools` 后 `finishRun(failed\|completed)` |
| **新增** | `tool-result.ts`、`ChatService.summarizeRunTools` |
| **用户可见** | 工具业务失败时会 emit `任务执行失败：…` 状态消息（`runStatusMessage`） |
| **说明** | 模型本身往往已诚实；修的是 **run/tool 账本与收口**，不是逼模型改口 |

### 5.2 P1 — 放大成本与难 debug

| ID | 问题 | 现状 | 后果 |
|----|------|------|------|
| **H5** | Skills 全关 | `noSkills: true` | 领域纪律只能塞 system，膨胀且难演进 |
| **H6** | 无 Agent eval | 单元测试为主 | harness 改动靠手点，回归不可见 |
| **H7** | 可观测不完整 | **实现中（2026-08-07）**：LangSmith 双写 + error_code + job trace 关联；本地账本仍为产品真相 | 开发者可在 Smith 看 run 树 |
| **H8** | ~~双通道写桌~~ | **已解决（2026-08-07）**：面板接同一 Job 外壳 + history 同栈 | 见 §5.2.1 |
| **H9** | 并发 run 记账 | 事件绑 `activeRunIds[0]` | 跟发时 tool 可能记到错误 run |

#### 5.2.1 H8 落地说明

| 项 | 内容 |
|----|------|
| **改前** | 面板同步 `generate()`；Agent 异步 job；history 仅面板 |
| **改后** | `POST /generate-image` → `jobs.run` 秒级 `accepted+task_id`；`agent_jobs.thread_id` nullable；`input.origin` |
| **History** | `recordGenerateOnce`：面板 accepted + Agent `object_changed` 去重同栈 |
| **Stop** | `cancelThread`：不杀面板 `thread_id=null` job |
| **规格** | [h8-unified-generate-design](superpowers/specs/2026-08-07-h8-unified-generate-design.md) |

### 5.3 P2 — 下一阶段

| ID | 问题 |
|----|------|
| **H10** | 无 cost / rate limit / 每项目生图互斥（agent 与面板） |
| **H11** | Compaction 黑盒：无「保留选中 artifact / 最近工具结果」策略 |
| **H12** | 状态栏拼进 user 字符串，不是独立 meta 通道（可用，难演进） |
| **H13** | 无 proposer–reviewer（工具成功 ≠ 设计可接受） |
| **H14** | 删除项目时未清 `data/agent-sessions/{projectId}`（磁盘残留，可后续补） |

---

## 6. 对照：Harness 五件事

| Harness 能力 | 砌间现状 | 判断 |
|--------------|----------|------|
| 稳定工具调用 | 1 个写桌工具 + 描述 | 半成品：失败语义 / 超时 UX 弱 |
| 抗幻觉 | system 写「以工具为准」 | **执行层未强制**（无结果校验） |
| 越权 / 护栏 | 项目归属校验 | 无配额、无危险操作分级 |
| 指令遵循 | system + tool guidelines | 无 eval 度量 |
| Loop 工程 | 单轮 prompt + **pi JSONL resume** | durable 上下文已有；缺 run 诚实 / 长工具不堵 |

能力债（眼睛/手）与 harness 债已部分解耦：Phase 0/1 接了选中与写桌；**剩余 P0 主线是 H3**。

---

## 7. 与「已离线」等现象的关系

| 现象 | 更可能属于 |
|------|------------|
| 右侧「已离线」 | WS harness（后端重启、主动 close、重连策略） |
| 生图失败仍像「任务完成」 | ~~H2~~ 已收口；若仍出现查 tool 是否落库 / 前端是否展示 run-status |
| 重试又长一张新图 | 业务路径 bug（已修 target 重试）+ H8 双通道 |
| 对话失忆上一轮落了哪张图 | ~~H1/H4~~ 若仍出现：查 JSONL 是否写入、或 compaction/H11 |

业务 bug 与 harness 债会叠在一起；修 harness 时应用 **现象 → ID** 对照，避免只改 UI 文案。

---

## 8. 治理路线（只 harness，默认不加新业务工具）

### 切片 A — Run 诚实 ← **已完成（H2）**

- 工具 `details.ok === false` / `status=failed` / `isError` → tool 记 `failed`  
- `chat-gateway`：`summarizeRunTools` → `finishRun(failed|completed)`  
- 失败时广播 `任务执行失败：…`（`runStatusMessage`）  

**对应：** H2  

### 切片 H7 — LangSmith 观测 ← **已接线（Phase 1）**

- `apps/server/src/agent/tracing/*`：Tracer / Noop / map-error / 有界队列 / TraceRegistry  
- env：`LANGSMITH_TRACING` `LANGSMITH_API_KEY` `LANGSMITH_PROJECT` `LANGSMITH_ENDPOINT?` `LANGSMITH_DEBUG_SYNC?`  
- root 等本 run jobs 终态再 end；job span parent=root；`chat_runs.smith_run_id` + `agent_jobs.trace_*`  
- 测试：map-error + Noop；生命周期手测  

### 切片 B — 长工具不堵 loop ← **已完成（H3 + H8 面板）**

- 设计：[async-agent-tools](superpowers/specs/2026-08-07-async-agent-tools-design.md)、[H8](superpowers/specs/2026-08-07-h8-unified-generate-design.md)  
- `agent_jobs` + `AgentJobRunner`：tool 与面板秒级 `accepted + task_id`  
- `generate_from_desk` 异步；`get_task`；状态栏 `[后台任务]`；`agent_job_updated`  
- 面板 `POST /generate-image` 同源 Job 外壳  

**对应：** H3、H8  

### 切片 C — 模型上下文持久化 ← **已完成（H1）**

- 用 pi `SessionManager.continueRecent`，按 `projectId/threadId` 独占目录  
- **不**再自搓 `restoreChatMessages` / DB 文本假恢复  
- 回归：`apps/server/src/agent/session-persist.test.ts`  

**对应：** H1、H4（模型侧）  

### 切片 D — 可观测 + 迷你 eval（可并行）

- ~20 条黄金任务：选中说话 / 无选中拒写 / 失败不说成功 / 重试原卡  
- run+tool 查询字段标准化；可选简易 trace  

**对应：** H6、H7  

### 明确先不做

- multi-agent 编排  
- 为大而全 skill 平台先上框架  
- 推倒 pi / 重写 session 池  

---

## 9. 成功标准（Harness 视角）

1. 后端热重启后：桌面页 WS 能回到「已连接」，聊天记录不丢。  
2. ~~生图失败：run / UI 不标成无条件成功~~ → **H2 已达成**：tool 业务失败 → run `failed` + 状态消息。  
3. 长生图过程中：用户能看到 pending 卡，不必干等无反馈。  
4. ~~新 session 恢复后：模型至少知道最近写桌结果摘要~~ → **H1 已达成**：JSONL 含完整 tool 轨迹（有 assistant 后落盘）。  
5. 改 harness 有可重复的黄金任务，不全靠手点。  

---

## 10. 非目标

- 不在本文规定图像供应商  
- 不展开 SFT/RL、多 agent 社会模拟  
- 不替代 ADR；session 持久化与 run 收口已用现有 schema（无新 status 枚举）  
- 不要求一次还清 H3–H14  

---

## 11. 建议的「下一刀」

> **切片 B（pending 先推）** → **切片 D（eval）**

切片 A（H2）、C（H1）已落地。与产品功能迭代可穿插；**堵死 loop 应优先于再加新工具**。

---

## 12. 参考

- 本仓库：`apps/server/src/agent/*`（尤其 `session-factory.ts`、`session-paths.ts`、`session-persist.test.ts`）、`src/app/useChatSession.ts`、`src/lib/api/chat-socket.ts`  
- [agent-design-frontier-review.md](agent-design-frontier-review.md)  
- pi：`SessionManager.continueRecent` / session JSONL 格式（`@earendil-works/pi-coding-agent` docs）  
- 李博杰，《深入理解 AI Agent》v1.2：Harness / Loop 工程、上下文恢复  
- Anthropic, *Building effective agents*；Cognition, *Don’t Build Multi-Agents*  
