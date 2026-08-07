# 设计：通用异步 Agent 工具（方案 2 · Job 外壳）

**状态：** DRAFT  
**日期：** 2026-08-07  
**分支：** `codex/canvas-reliability`  
**相关：** [agent-harness-audit H3](../../agent-harness-audit.md)、[ADR 0013](../../adr/0013-agent-generate-from-desk.md)、H1/H2 已落地（`e305ac1`）

---

## 1. 问题

`generate_from_desk`（及未来其它慢执行工具）在 `execute` 内 `await` 整次副作用（生图最长 ~120s）：

- Agent loop / `chat.busy` 被钉死，用户不能正常再聊
- 桌上 pending 能力已有，但 Agent 路径要等整次 `generate()` 结束才 `object_changed`
- 痛点是 **执行类工具的外壳**，不单是生图

## 2. 目标 / 非目标

### 目标

1. 慢执行工具：`execute` **秒级**返回 `accepted + task_id`
2. 真干活在后台；**世界状态**（桌面 artifact 等）持中间态与终态
3. **通用 Job 外壳**，不绑死生图；第一期只接入 `generate_from_desk`
4. 模型本轮只保证知「已受理」；之后靠 **状态栏摘要 + `get_task`**
5. 人：对话不因出图冻结；桌上先有 pending 卡
6. 为方案 3（事件总线）预留：稳定 `task_id`、统一 `finalizeJob`，**默认不**因完成自动再 `prompt`

### 非目标（第一期）

- 完成后自动再开一轮 Agent 对话（方案 3）
- 分布式队列 / 多 worker
- 工具自动重试引擎
- 第二个业务 async 工具实现（只留注册口）
- 面板 HTTP 生图改异步（仍可同步 await；H8 后续统一）

## 3. 决策摘要

| 项 | 选择 |
|----|------|
| 架构 | 方案 2：Job 表 + `runAsyncJob` 外壳 |
| 终态回模型 | **可查询 + 状态栏**（非自动再聊） |
| 第一期工具 | `generate_from_desk` 异步化 + `get_task` |
| 面板生图 | 暂不改 |
| WS | `object_changed` + **`agent_job_updated`** |
| 取消 | chat stop → cancel 该 project 进行中 jobs |

## 4. 核心比喻

| 挂号 | 本设计 |
|------|--------|
| 取号 | tool 立即 `accepted` + `task_id` |
| 候诊屏 | 状态栏 `[后台任务]` + `get_task` |
| 诊室 | 后台 runner |
| 结果/病历 | 世界状态（effect 卡等） |

pi 语义不变：`execute` 返回后本轮 tool 才结束——返回值是 **接单**，不是 **出餐完毕**。

## 5. 数据模型：`agent_jobs`

独立表（不塞进 `chat_tool_calls`：tool 行表示本轮已返回 accepted；job 生命周期更长）。

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | uuid PK | = `task_id` |
| `project_id` | uuid | 项目 |
| `thread_id` | uuid | 对话线程 |
| `run_id` | uuid nullable | 受理时所在 chat run |
| `kind` | text | 如 `generate_from_desk` |
| `status` | text | 见下 |
| `input` | jsonb | 工具参数快照 |
| `result` | jsonb nullable | 终态摘要（禁 base64） |
| `artifact_id` | uuid nullable | 世界锚点 |
| `error` | text nullable | 短错误 |
| `created_at` / `started_at` / `finished_at` | timestamptz | |

**status：** `accepted` | `running` | `succeeded` | `failed` | `cancelled` | `interrupted`

**进程重启：** 启动时将仍为 `accepted`/`running` 的 job 标 `interrupted`（对齐 chat run 陈旧处理）。

索引建议：`(project_id, status)`、`(project_id, created_at desc)`。

## 6. 工具返回协议

### 6.1 受理成功（async tool 立即返回）

```ts
{
  content: [{ type: "text", text: "已开始… task_id=… 请在桌面查看进度" }],
  details: {
    ok: true,
    async: true,
    status: "accepted",
    task_id: string,
    kind: string,
    artifact_id?: string,
  }
}
```

### 6.2 同步失败（未创建 job）

沿用 `fail()`：`details.ok === false`，无 `task_id`。

### 6.3 `get_task`

```ts
details: {
  task_id, kind, status,
  artifact_id?: string,
  error?: string,
  // 可选短 result 字段，禁止大图/base64
}
```

### 6.4 模型纪律

- `async: true` 且 `status` 为 `accepted`/`running` → **禁止**声称已生成完成
- system / tool guidelines 写明；完成以桌面与 `get_task` 为准
- H2：本轮 run 在 **受理成功** 时为 `completed`；**同步** fail 才 `failed`。出图后台失败 **不** 回写本轮 run 为 failed

## 7. 模块

```
apps/server/src/agent/
  async-job/
    types.ts
    store.ts       # drizzle CRUD
    runner.ts      # kind → handler；spawn；AbortController map
    protocol.ts    # accepted / 列表 DTO
  tools/
    generate-from-desk.ts  # 校验 → prepare 世界 → runAsyncJob → return accepted
    get-task.ts
  desk-status.ts           # + [后台任务]
  events.ts                # + agent_job_updated
```

### 7.1 `runAsyncJob`

```ts
async function runAsyncJob(opts: {
  projectId: string;
  threadId: string;
  runId?: string;
  kind: string;
  input: unknown;
  prepare: (jobId: string) => Promise<{ artifactId?: string }>; // 同步世界副作用
  work: (ctx: { jobId: string; signal: AbortSignal; artifactId?: string }) => Promise<unknown>;
}): Promise<AcceptedDetails>
```

顺序（硬约束）：

1. insert job `accepted`
2. **await `prepare`**（pending 卡等）→ 更新 `artifact_id`
3. emit `object_changed`（若有 artifact）+ `agent_job_updated`
4. 注册 AbortController；**启动**后台 `work`（不 await）
5. **return** accepted details 给 tool `execute`

后台：

1. status → `running`，`started_at`
2. `await work(signal)`
3. 成功 → `succeeded` + result；失败/abort → `failed`/`cancelled` + error
4. 世界终态由 `work` 内更新（与现有 generate 后半段一致）
5. `finalizeJob`：写库 + emit（**唯一**终态出口，预留以后 enqueue wake）

### 7.2 `generate_from_desk` 改造

| 阶段 | 内容 |
|------|------|
| 同步 | 校验 source；`prepareNewTarget` / 重试 prepare；`object_changed` |
| 异步 `work` | 现有 `images.generate` + append 成功/失败 payload |
| 返回 | `accepted` + `task_id` + `artifact_id`，**不再** await 整次出图 |

可拆 `CanvasGenerateService`：`prepare…` 与 `completeImage…` 分离，避免 Agent/面板耦合失控；面板路径第一期仍可一次 `generate()` 内部串完。

**重试：** 第一期 Agent 可不接 `target_artifact_id`；人点失败卡走面板。后续再暴露。

### 7.3 `get_task`

- 参数：`task_id`（必填）
- 校验 job 属于当前 `projectId`
- 返回 6.3 形状

### 7.4 取消

- `ChatGateway` stop / `sessions.stop`：除现有 abort session + `generate.abortProject` 外，**cancel 该 project 所有 `accepted`/`running` jobs**
- 超时：work 内 120s abort → job `failed`，卡 error（文案可含超时）

## 8. 状态栏

在 `[桌面状态]` 后追加：

```
[后台任务]
- running  generate_from_desk  task=…  artifact=…  「日式…」
- failed   …  error=…
```

规则：

- 当前 `projectId`
- 优先 `accepted`/`running`，再 1h 内终态，合计最多 5 条
- `session-registry.prompt`：snapshot 同时 `listRecentJobs(projectId)`

## 9. 事件

```ts
| { type: "agent_job_updated"; projectId: string; taskId: string;
    status: JobStatus; kind: string; artifactId?: string; error?: string }
```

- 前端：可选刷新过程 UI；桌面仍以 `object_changed` 为主
- **不**默认触发新一轮 `session.prompt`

## 10. 与 H1 / H2 / busy

| | 行为 |
|--|------|
| H1 | pi JSONL 记 accepted toolResult；终态在 job + 桌 |
| H2 | 受理成功 → run completed；同步工具 fail → failed；后台出图失败不改本轮 run |
| busy | tool 秒级返回 → 可再聊；桌继续变 |

## 11. 测试计划

1. **协议：** `runAsyncJob` mock：prepare 后立即得到 accepted，work 仍 pending  
2. **生图成功：** pending 卡 → 后台后有 file_id；job succeeded  
3. **生图失败：** job failed + 卡 error  
4. **stop：** running job → cancelled / abort 图像  
5. **get_task：** 跨 project 拒绝；状态正确  
6. **状态栏：** 含 running 行  
7. **gateway：** 仅受理成功时 finishRun completed（无失败 tool 行）

## 12. 实施切片（建议顺序）

| 步 | 内容 |
|----|------|
| T1 | migration + store + types |
| T2 | runner + protocol + finalizeJob |
| T3 | generate_from_desk 接入 + CanvasGenerate 可拆 prepare/complete |
| T4 | get_task + desk-status + events |
| T5 | stop → cancel jobs |
| T6 | 测试 + harness 文档更新 |

## 13. 风险

| 风险 | 对策 |
|------|------|
| accepted 时桌上无卡 | prepare 必须在 return 前完成 |
| 模型谎称完成 | system + guidelines |
| 重复调工具双卡 | 文案引导看桌；后期 target 重试 |
| 后台 unhandled | runner 统一 catch → failed |
| 热重载丢 running | 启动 interrupt 陈旧 job |
| H8 双通道 | 第一期只改 Agent；幂等 clientOpId 保留 |

## 14. 演进到方案 3（预留）

```
L1 本设计（Job 外壳）
L2 finalizeJob 已 emit agent_job_updated
L3 多事件源入队
L4 策略 + 可选自动 prompt
```

L1 的 `finalizeJob` 单一出口保证 L4 只加策略、不返工业务工具。

## 15. 成功标准

1. Agent 生图：用户在数秒内可再发消息（busy 结束）  
2. 桌上在 tool 返回前后出现 pending 卡  
3. 完成后卡更新；失败卡可面板重试  
4. 状态栏或 `get_task` 能反映 running/终态  
5. stop 能打断进行中生图 job  

## 16. 待实现前确认（默认已取推荐）

| 问题 | 默认 |
|------|------|
| 第一期 `get_task` | **要** |
| 面板生图异步 | **不要** |
| `agent_job_updated` | **要** |

若评审改默认，改本文再动代码。
