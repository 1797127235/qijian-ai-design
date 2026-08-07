# 设计：H8 双通道写桌统一（面板 + Agent）

**状态：** DRAFT  
**日期：** 2026-08-07  
**分支：** `codex/canvas-reliability`  
**相关：** [agent-harness-audit H8](../../agent-harness-audit.md)、[H3 async-agent-tools](2026-08-07-async-agent-tools-design.md)、[ADR 0013](../../adr/0013-agent-generate-from-desk.md)、[canvas-connections-generate](../../canvas-connections-generate-design.md)

---

## 1. 问题

同一业务（源物件 + prompt → 源旁 `effect_image`）有两条入口：

| 通道 | 入口 | 现状 |
|------|------|------|
| 面板 | `POST /api/projects/:id/generate-image` | 同步 `generate()`，HTTP 挂到 complete（~120s） |
| Agent | `generate_from_desk` tool | H3 已异步：`prepare` + `jobs.run` → 秒级 `accepted` |

共享层已有：`CanvasGenerateService.prepare` / `complete`、pending 卡、连线、`clientOpId` 幂等、`lockKey` inflight。

**未统一：**

1. **外壳** — 面板仍同步堵 HTTP；Agent 不堵 loop  
2. **互斥** — 两通道理论共用 `inflight`，但面板不经 job 表，stop/查询语义分裂  
3. **History / Undo** — 仅面板 `history.record`；Agent 落桌不进同一撤销栈  
4. **进度协议** — 面板靠 HTTP 终态；Agent 靠 WS + `task_id`

H3 明确把「面板改异步」列为非目标；H8 补这一刀。

---

## 2. 目标 / 非目标

### 目标

1. **H8a 外壳统一**：面板与 Agent 共用 **Job 外壳**（`AgentJobRunner` + `agent_jobs`）  
2. 面板 HTTP **秒级**返回 `accepted + task_id + artifact`（与 Agent 同构）  
3. **跨通道互斥**：同一 `lockKey` 后发 abort 先发；stop/cancel 可查同一 job 账本  
4. **H8b History 统一**：两通道 pending 落桌后进 **同一** undo 栈，语义一致  
5. 重试（`targetArtifactId`）不双开卡、不重复记 history 条目  

### 非目标

- 完成后自动再开 Agent `prompt`（H3 方案 3）  
- 公开 REST `GET /jobs/:id` / `202 Location` 轮询资源（终态以 WS 为准）  
- 独立 `panel_jobs` 表  
- 改图像供应商 / 多 worker / 分布式队列  
- 新增写桌业务工具（便签等）  
- multi-agent  

---

## 3. 决策摘要

| 项 | 选择 | 理由 |
|----|------|------|
| 架构 | **A：面板接入同一 Job 外壳** | 真统一，复用 H3 |
| 范围 | **H8a + H8b** | 外壳 + history/undo 一次对齐 |
| HTTP 契约 | **秒级 `accepted + task_id`** | 与 Agent 同构；靠 WS 等终态 |
| Job 存储 | **同一 `agent_jobs`** | 互斥/stop/事件一套；`origin` 区分通道 |
| History | **两通道同栈可撤销** | 用户不感知来源 |
| 终态回客户端 | **`object_changed` + `agent_job_updated`** | 已有；不新增 REST job API |

---

## 4. 架构

```
面板 HTTP                    Agent tool
     │                            │
     ▼                            ▼
 origin=canvas_panel         origin=agent_chat
 clientOpId=UUID             clientOpId=agent:{toolCallId}
     │                            │
     └────────────┬───────────────┘
                  ▼
    CanvasGenerateService.prepare
    （同步：pending 卡 + 连线 + 幂等缓存）
                  │
                  ▼
    AgentJobRunner.run → agent_jobs 行
                  │
         ┌────────┴────────┐
         │ 立即返回        │ 后台
         ▼                 ▼
   accepted+task_id    complete()
   + artifact          → append 终态
                       → object_changed
                       → agent_job_updated
```

**不变式：**

1. `prepare` 必须在返回 `accepted` **之前**完成（桌上先有 pending 卡）  
2. 调用方 **禁止** await `work`/`complete`（否则外壳退化）  
3. 业务写桌 **只** 经 `CanvasGenerateService`；Job 只负责生命周期外壳  
4. 世界状态（artifact 版本）是产品真相；job 行是进度账本  

---

## 5. 数据与协议

### 5.1 `agent_jobs` 扩展

复用现表；**不新增 `origin` 列**。通道写入 `input.origin`：

```json
{
  "origin": "canvas_panel" | "agent_chat",
  "prompt": "…",
  "source_artifact_id": "uuid",
  "target_artifact_id": "uuid?",
  "client_op_id": "…"
}
```

`kind` 两通道均为 `generate_from_desk`。  
`thread_id` / `run_id`：**nullable**（migration 将 `agent_jobs.thread_id` 从 NOT NULL 放宽）；面板 job 仅 `project_id` + `input.origin=canvas_panel`。

| 字段 | 面板 | Agent |
|------|------|-------|
| `project_id` | 必填 | 必填 |
| `thread_id` | null | 当前 thread |
| `run_id` | null | 受理时 run |
| `kind` | `generate_from_desk` | 同 |
| `input.origin` | `canvas_panel` | `agent_chat` |
| `input` 其余 | prompt, source, target?, client_op_id | 同结构 |
| `artifact_id` | prepare 后 | 同 |

### 5.2 面板 HTTP 契约（破坏性变更）

**请求**（不变）：

```json
{
  "prompt": "…",
  "sourceArtifactId": "uuid",
  "clientOpId": "…",
  "targetArtifactId": "uuid?" 
}
```

**响应（改后）** — 受理成功 `201`：

```json
{
  "status": "accepted",
  "task_id": "uuid",
  "async": true,
  "artifact": { "id": "uuid" },
  "version": { "id": "uuid", "status": "draft" },
  "object": { "…layout…" },
  "connection": { "…" }
}
```

**同步失败**（prepare 未完成、未受理）— 抛既有 `HttpError`（如 404 源不在桌、422 校验），**不**创建 job 行。  
与 complete 业务失败区分：后者只出现在 WS / 卡上 `payload.error`，不再经本 HTTP。

**不再** 在 HTTP 响应中返回 complete 的 `status: "succeeded" | "failed"`。  
终态只通过：

- `object_changed`（artifact 版本更新）  
- `agent_job_updated`（job 状态）  

### 5.3 Agent 协议

保持 H3：`accepted + task_id` + `get_task` + 状态栏 `[后台任务]`。  
`origin=agent_chat` 写入 job input。

### 5.4 幂等

| 通道 | clientOpId |
|------|------------|
| 面板 | 前端 `crypto.randomUUID()` |
| Agent | `agent:{toolCallId}` |

`CanvasGenerateService.recent` 10min 窗口保留；相同 `clientOpId` 返回同一 pending/终态缓存。

---

## 6. 互斥 / 取消

### 6.1 lockKey

```
lockKey = `${projectId}:${targetArtifactId ?? sourceArtifactId}`
```

- 两通道共用 `CanvasGenerateService.inflight`  
- 同 key 新 `complete` 会 abort 旧 controller（现逻辑）  
- Job 层：新 job 在 `prepare` 成功后、启动 `work` 前，将同 `project_id` + 同 `artifact_id`（或同 lock 源）上仍为 `accepted`/`running` 的旧 job **标 `cancelled` 并 abort**；旧 work 收到 abort → 不再写成功终态

### 6.2 Cancel 矩阵

| 触发 | 范围 |
|------|------|
| Chat stop | 当前 **thread** 的 active jobs（对齐 TODO #8；H8 顺带从 project 级收窄） |
| 面板用户取消（若 UI 有） | 该 `task_id` / artifact 对应 job |
| 服务重启 | 启动 `interruptStale`（H3 已有） |
| 同 lock 新请求 | abort 旧 inflight + 旧 job 终态 |

面板 job 无 thread：stop 聊天 **不** 误杀面板 job（仅 cancel 当前 thread 的 jobs）。

---

## 7. History / Undo（H8b）

### 7.1 原则

- 用户看到的是 **桌上多了一张图**，不区分谁触发  
- 撤销 = 世界状态回退（删卡/布局），与 `source` 字段无关  

### 7.2 何时 record

| 事件 | 是否 `history.record({ type: "generate", … })` |
|------|-----------------------------------------------|
| 新建 pending 落桌（prepare 成功） | **是**（两通道） |
| 重试 `targetArtifactId`（原卡 append） | **否**（版本前进，与现面板一致） |
| complete 成功/失败 | **否**（不新增条目；卡已在栈中） |

### 7.3 Agent 路径如何进栈

前端已有 `object_changed` 处理。统一策略：

1. **推荐**：`object_changed` 携带足够信息时，若为 **新** `effect_image` 且 `undoable !== false`，由统一 desk 事件处理器 `history.record`  
2. 面板 `useDeskGenerate` 在收到 accepted 后也可 record（与现一致）；需 **幂等**：同一 `artifactId` 不重复 record（用 Set 或 history 内去重）  

服务端：Agent 路径 emit `object_changed` 时设 `undoable: true`（与可撤销放置一致）。

### 7.4 Undo 语义

- Undo generate = 移除该 effect 卡 + 连线（或现有 generate undo 实现）  
- 不调用「反向生图」  
- 进行中 job：undo 应 **cancel job** + 删卡（实现注意竞态：complete 与 undo 并发 → 以 artifact 删除为准，complete 写版本失败则 failed）

---

## 8. 前端改动

### 8.1 `useDeskGenerate`

- `api.generateImage` 期望 `status: "accepted"` + `task_id`  
- **不再** await 业务终态  
- accepted 后：`history.record`（新建时）、`refreshDesk` 或依赖 WS、关闭面板  
- `busySourceId`：accepted 后 **立即清除**；进行中态只靠卡片 `pending` UI  
- 失败：prepare → catch/toast；complete → 卡上 `error`（不强制全局 toast）

### 8.2 API 类型

`GenerateFromCanvasResult` 扩展：

```ts
// 面板 HTTP 成功体（201）
{ status: "accepted"; task_id: string; async: true; artifact; version; object; connection }
// prepare 失败走 HttpError，无 body status=failed
```

### 8.3 WS

已有 `object_changed` / `agent_job_updated`；确保面板页订阅与聊天页一致（同 project socket）。

---

## 9. 后端改动清单

| 层 | 改动 |
|----|------|
| `routes/desk.ts` | `generate-image` 改为 prepare + `jobs.run`；返回 accepted |
| `CanvasGenerateService` | `generate()` 可标 deprecated 或改为薄封装调 job；面板与 agent 都走 prepare+runner |
| `AgentJobRunner` | 支持无 `threadId`/`runId` 的面板 job；input 写 origin |
| `session-registry` stop | cancel **thread** jobs，不 cancel 全 project（TODO #8） |
| schema | migration：`agent_jobs.thread_id` nullable；origin 仅写 input |
| 测试 | 面板 accepted 契约；跨通道互斥；history 去重；stop 不杀面板 job |

---

## 10. 实施切片

| 步 | 内容 | 对应 |
|----|------|------|
| T1 | schema：thread_id nullable / origin；store 适配面板 create | H8a |
| T2 | desk 路由改 async accepted；runner 面板入口 | H8a |
| T3 | 前端 `useDeskGenerate` + API 类型 | H8a |
| T4 | history：Agent `object_changed` record + 去重；undo+cancel 竞态 | H8b |
| T5 | stop 收窄到 thread（TODO #8） | H8a 附带 |
| T6 | 测试 + 更新 harness 审计 H8 状态 | 收尾 |

建议顺序：T1→T2→T3 可先合并（面板不卡）；T4/T5 紧随。

---

## 11. 风险

| 风险 | 对策 |
|------|------|
| 前端仍按旧同步契约解析 | 类型 + 单测 + 手测面板生图 |
| 双 record history | artifactId 去重 |
| undo 与 complete 竞态 | complete 写前查 artifact 仍在；否则 failed |
| stop 误杀面板 job | cancel 按 thread；面板 thread_id=null |
| `agent_jobs` 命名困惑 | 文档写明 = 通用 async 写桌 job；暂不改表名（避大迁移） |
| 幂等重复 accepted | clientOpId 缓存返回同一 artifact/task |

---

## 12. 成功标准

1. 面板点生成：HTTP **秒级**返回；聊天输入不因生图冻结  
2. 桌上先出现 pending 卡，完成后变为图或 error  
3. 面板与 Agent **同时**对同一源生图：后发 abort 先发，不双卡（无 target 时）或行为可文档化  
4. Agent 落桌卡与面板卡 **均可 undo**，栈语义一致  
5. 失败卡重试：`targetArtifactId` 原卡更新，不新建 history 条目  
6. Chat stop 取消对话 jobs，**不**取消进行中的纯面板 job  

---

## 13. 与既有文档关系

| 文档 | 关系 |
|------|------|
| H3 async-agent-tools | 本设计撤销其「面板暂不改」非目标；复用 Job 外壳 |
| harness H8 | 落地后标 **已解决**（或 H8a/H8b 分记） |
| ADR 0013 | 不改 Agent 写桌语义；补「面板同源」 |
| canvas-connections-generate | pending/连线/重试规则保持 |

---

## 14. 明确先不做

- REST job 轮询 API  
- 表改名 `agent_jobs` → `async_jobs`（可后续 chore）  
- 面板与 Agent 的 cost/rate limit（H10）  
- proposer–reviewer（H13）  

---

## 15. 评审确认记录

| 问题 | 决议 |
|------|------|
| 范围 | H8a + H8b 完整统一 |
| History | 与面板相同可撤销（同栈） |
| HTTP | 秒级 accepted + task_id（非 202 Location） |
| Job 存储 | 同一 `agent_jobs` |
| 架构 | A：面板接入同一 Job 外壳 |
