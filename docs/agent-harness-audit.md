# Agent Harness 审计

**状态：** 调研结论（供决策，非 ADR）  
**日期：** 2026-08-06  
**范围：** `apps/server/src/agent/*` 与对话 WS 相关前端；只谈 **Harness（基础设施）**，不谈新业务功能清单。  
**相关：** [agent-design-frontier-review](agent-design-frontier-review.md)、[ADR 0012](adr/0012-agent-analysis-only.md)、[ADR 0013](adr/0013-agent-generate-from-desk.md)、Phase 0/1 specs under `docs/superpowers/specs/`

---

## 1. 一句话

能力面已有第一刀（选中进上下文 + `generate_from_desk` 写桌）；  
**Harness = 让 Agent loop 可靠的外壳**，当前是「能跑」多于「跑稳」。  
优先还债：session 恢复、run 诚实、长工具不堵、历史带回工具真相。

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
            → session-restore  DB 聊天重灌
            → agent-event-persister  tool 起止落库
```

| 层 | 路径 | Harness 职责 |
|----|------|----------------|
| 入口 | `chat-gateway.ts` | 校验、ack、finishRun |
| 会话 | `session-registry.ts` / `session-factory.ts` | 池化、prompt 组装、工具注入 |
| 上下文 | `desk-status.ts` / `session-restore.ts` | 看见什么、恢复什么 |
| 手脚 | `tools/*` | ACI + 写桌副作用 |
| 可观测 | `agent-event-persister.ts` + chat runs | 事后能否复盘 |
| 前端通道 | `src/lib/api/chat-socket.ts` / `useChatSession` | WS 连接与重连 |

---

## 4. 已有基础（保留）

1. **Run + tool call 落库**（start/finish tool）  
2. **EventWriteTracker**：prompt 结束前可 await 写库  
3. **Idle 回收 + stop/abort**  
4. **用户原文与状态栏分离**（状态栏不进 `chat_messages` 正文）  
5. **单写桌工具 + `object_changed`**（ADR 0013）  
6. **WS 断线重连**（开发热重启后可恢复连接，不清消息）  
7. **Compaction 开启** + 历史视觉限流  

这些是 harness 骨架，后续债应 **补强而非推倒**。

---

## 5. 核心问题（按严重度）

### 5.1 P0 — 直接伤产品信任

| ID | 问题 | 现状 | 后果 |
|----|------|------|------|
| **H1** | Session 只在内存 | `SessionManager.inMemory()` | 进程热更/崩溃：进行中轨迹丢；重连后只靠聊天文本重灌，**工具结果不回灌模型** |
| **H2** | Run 完成语义过粗 | 工具 `fail()` / 生图失败仍可能 `finishRun("completed")` | 假成功：run 绿、桌面失败卡 |
| **H3** | 长工具堵死整轮 | `generate` 同步等到约 120s | 体感挂死、WS「已离线」、pending 难中途展示 |
| **H4** | 历史上下文残缺 | restore 主要是 user/assistant 文本 + 有限图 | 模型不知上一轮工具与落桌结果 → 重复生成、说错状态 |

### 5.2 P1 — 放大成本与难 debug

| ID | 问题 | 现状 | 后果 |
|----|------|------|------|
| **H5** | Skills 全关 | `noSkills: true` | 领域纪律只能塞 system，膨胀且难演进 |
| **H6** | 无 Agent eval | 单元测试为主 | harness 改动靠手点，回归不可见 |
| **H7** | 可观测不完整 | tool 有落库，缺 trace UI / 失败分类 | 「未找到 Artifact」类问题难归因 |
| **H8** | 双通道写桌 | 面板 HTTP 生图 vs agent 工具 | 幂等 / 历史 / 撤销语义不统一 |
| **H9** | 并发 run 记账 | 事件绑 `activeRunIds[0]` | 跟发时 tool 可能记到错误 run |

### 5.3 P2 — 下一阶段

| ID | 问题 |
|----|------|
| **H10** | 无 cost / rate limit / 每项目生图互斥（agent 与面板） |
| **H11** | Compaction 黑盒：无「保留选中 artifact / 最近工具结果」策略 |
| **H12** | 状态栏拼进 user 字符串，不是独立 meta 通道（可用，难演进） |
| **H13** | 无 proposer–reviewer（工具成功 ≠ 设计可接受） |

---

## 6. 对照：Harness 五件事

| Harness 能力 | 砌间现状 | 判断 |
|--------------|----------|------|
| 稳定工具调用 | 1 个写桌工具 + 描述 | 半成品：失败语义 / 超时 UX 弱 |
| 抗幻觉 | system 写「以工具为准」 | **执行层未强制**（无结果校验） |
| 越权 / 护栏 | 项目归属校验 | 无配额、无危险操作分级 |
| 指令遵循 | system + tool guidelines | 无 eval 度量 |
| Loop 工程 | 单轮 prompt 循环 | **缺 durable loop / resume** |

能力债（眼睛/手）与 harness 债已部分解耦：Phase 0/1 接了选中与写桌；**H1–H4 仍是基础设施主线**。

---

## 7. 与「已离线」等现象的关系

| 现象 | 更可能属于 |
|------|------------|
| 右侧「已离线」 | WS harness（后端重启、主动 close、重连策略） |
| 生图失败仍像「任务完成」 | H2 run 语义 |
| 重试又长一张新图 | 业务路径 bug（已修 target 重试）+ H8 双通道 |
| 对话失忆上一轮落了哪张图 | H1 / H4 恢复 |

业务 bug 与 harness 债会叠在一起；修 harness 时应用 **现象 → ID** 对照，避免只改 UI 文案。

---

## 8. 治理路线（只 harness，默认不加新业务工具）

### 切片 A — Run 诚实（小、立刻有感）

- 约定：工具 `details.ok === false` 或业务 `status=failed` → run 记 `failed` 或 `completed_with_errors`  
- `chat-gateway` 在 `sessions.prompt` 结束后根据 tool 结果收口  
- 前端区分「对话结束」与「生图/工具失败」  

**对应：** H2  

### 切片 B — 长工具不堵 loop（中）

- `generate_from_desk` / 生图：**先** pending 落桌 + `object_changed`，再等图像 API；或 tool 立即返回 `artifact_id + pending`  
- 用户看到骨架，而不是假离线  

**对应：** H3（并减轻 H1 体感）  

### 切片 C — 恢复时带回工具真相（中大）

- session 重建：recent tool calls 摘要，或可恢复 session 存储  
- 最低配：状态栏/恢复块带「最近 N 条已落桌 effect_image id + prompt」  

**对应：** H1、H4  

### 切片 D — 可观测 + 迷你 eval（可并行）

- ~20 条黄金任务：选中说话 / 无选中拒写 / 失败不说成功 / 重试原卡  
- run+tool 查询字段标准化；可选简易 trace  

**对应：** H6、H7  

### 明确先不做

- multi-agent 编排  
- 为大而全 skill 平台先上框架  
- 推倒 pi / 重写 session 池（除非 C 证明 in-memory 不可接受）  

---

## 9. 成功标准（Harness 视角）

1. 后端热重启后：桌面页 WS 能回到「已连接」，聊天记录不丢。  
2. 生图失败：run / UI **不**标成无条件成功。  
3. 长生图过程中：用户能看到 pending 卡，不必干等无反馈。  
4. 新 session 恢复后：模型至少知道最近写桌结果摘要（非空白失忆）。  
5. 改 harness 有可重复的黄金任务，不全靠手点。  

---

## 10. 非目标

- 不在本文规定图像供应商  
- 不展开 SFT/RL、多 agent 社会模拟  
- 不替代 ADR；改 run 语义 / session 持久化时另开 ADR  
- 不要求一次还清 H1–H13  

---

## 11. 建议的「下一刀」

文档落地后，实现优先：

> **切片 A（Run 诚实）** → **切片 B（pending 先推）** → **切片 C（恢复带工具摘要）**

与产品功能迭代可穿插；但 **假成功与堵死 loop 应优先于再加新工具**。

---

## 12. 参考

- 本仓库：`apps/server/src/agent/*`、`src/app/useChatSession.ts`、`src/lib/api/chat-socket.ts`  
- [agent-design-frontier-review.md](agent-design-frontier-review.md)  
- 李博杰，《深入理解 AI Agent》v1.2：Harness / Loop 工程、上下文恢复  
- Anthropic, *Building effective agents*；Cognition, *Don’t Build Multi-Agents*  
