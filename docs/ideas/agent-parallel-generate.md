# Agent 并发多路生图

## Problem Statement

How might we let a designer (via Agent) fan out several desk generates in one turn—same or different prompts—so they can compare on the desk without serial tool turns?

## Recommended Direction

**目标不变：** Agent 一轮 fan-out 多路桌面生图（同/异 prompt），一 task 一图，BullMQ 并行，JOB_EVENT 回注。

**实现路径修正（doubt cycle 后）：不要把 HTTP `AssetBatchSubmissionService` 当 Agent 的 drop-in。**

Agent 多路与设计师 HTTP batch 在 wake、origin、refs、model 校验上不是同一条路径。MVP 应走 **Agent 语义的 fan-out**，复用队列/prepare 能力，而不是原样调用 designer batch submit。

### 选定主路径：N 次 Agent 单路提交 + 工具可并行

1. 将 `generate_from_desk` / `text_to_image_on_desk` 的 `executionMode` 改为 **`parallel`**（`replace_on_desk` **保持 sequential**）。
2. 继续走 `runDeskGenerate` → `AssetTaskSubmissionService.submitAgentImage`：
   - `kind = generate_from_desk`（已在 `WAKEABLE_JOB_KINDS`）
   - 已写 `threadId` / `runId`
   - model allowlist、`ownedCurrent`、inbound 连线 refs 合并已存在
3. system prompt：对比探索时 **同一轮多次调用** 生图工具；`accepted` ≠ 完成；禁止轮询 `get_task`。
4. 产品软上限：指引 **2–4 路**；系统仍靠 unfinished 上限与项目 image concurrency 兜底。

**为何不先做 `generate_batch_on_desk` 包 HTTP batch：**

| 缺口 | 证据 |
|---|---|
| `acceptBatch` 不写 `threadId`/`runId` | `task-store.ts` insert 无这两列 |
| `taskKind: batch_generate` 不在 wake 白名单 | `WAKEABLE_JOB_KINDS = { generate_from_desk }` |
| origin/source 是 panel/batch 而非 agent | batch freeze / prepare 硬编码 |
| 无 model allowlist / ownedCurrent | 单路在 tool 层，batch 没有 |
| inbound 连线 refs 不自动合并 | 与 `submitAgentImage` 行为不一致 |

若后续要「一次 tool 一次 items[]」的显式 batch 工具，必须新建 **Agent batch 提交面**（acceptBatch 扩 thread/run、kind 可 wake、origin=agent、对齐 guards），**禁止**直接复用 designer `AssetBatchSubmissionService.submit` 当 Agent 路径。

### 成功标准

- 同一轮可多次 `accepted` + 多个 `task_id`，无需等图完成再提交
- 同 prompt ×N / 异 prompt ×N 均可；各落一卡
- 终态仍走现有 JOB_EVENT；不引入 provider `n>1`
- 不破坏 replace 安全（replace 不并行）

## Key Assumptions to Validate

- [ ] 模型在 `executionMode: parallel` 下会稳定一轮多调生图，而不是仍串行等 JOB_EVENT
- [ ] 2–4 路并排在默认 image concurrency=4 下体感明显优于串行工具轮次
- [ ] 多张 JOB_EVENT（debounce 窗口外多次 wake）时 Agent 能按 task_id 对齐，不谎称「已全部完成」
- [ ] 同主源多 `beside` 落位可接受（或需 index 错位）—— 仍可能叠卡
- [ ] 未完成任务硬顶（accept 层 ~100）与「排队不失败」的体感要分清：满硬顶会 422 整批/整次

## MVP Scope

**In**

- `generate_from_desk` + `text_to_image_on_desk` → `executionMode: "parallel"`
- `replace_on_desk` 保持 `sequential`
- system prompt / tool guidelines：一轮可多调；对比用多次旁落；accepted 非完成；禁 get_task 轮询
- 测试：同一 run 上下文连续两次 submitAgentImage 均带 threadId 且 kind wakeable；parallel 工具注册断言
- dogfood：Agent「出 3 个方向」→ 三张 pending → 终态回注

**Out of MVP**

- 新工具 `generate_batch_on_desk`（除非先做 Agent-batch 提交面，见上）
- 面板 count UI
- provider `n>1`
- replace 进并发
- batch 取消 UI
- 改 designer HTTP batch 语义

## Not Doing (and Why)

- **直接复用 `AssetBatchSubmissionService` 给 Agent** — 无 thread、非 wakeable kind、origin/source/refs/model 与 Agent 单路不一致；C4/C10 会假绿
- **Provider `n>1`** — 与一 task 一图、Grok edit n=1 冲突
- **`replace` 并行** — 同卡版本冲突
- **双路径同时推**（HTTP batch 工具 + parallel 单工具）— 加倍契约与模型误用面；MVP 只开 parallel 单工具
- **强制多变体阶段** — 保持自由桌面比选
- **把 C6 说成 accept 永不失败** — 项目 unfinished 硬顶会 422；仅 Worker 层 image concurrency 才是排队

## Open Questions

- parallel 后模型是否会「batch + 多次单调」叠出 2N 卡（暂无 batch 工具则风险低）
- 多 wake 叙事：是否要在 wake prompt 里带「仍在跑的 sibling task_ids」（需可观察 store）
- `beside` 同源 N 卡是否要在 prepare 按 index 偏移
- 是否要对 Agent 单轮生图次数做软上限（返回结构化错误而非靠 100 unfinished）

## Flow (reference)

```text
User: 按主源 A + 参考 B 出 3 个方向
  → Agent turn: generate_from_desk ×3 (parallel tool calls)
  → 各走 submitAgentImage（threadId/runId + kind=generate_from_desk）
  → 各 prepare pending + accept
  → Desk: 3 张 pending
  → Worker: 项目 image concurrency 内并行；超出排队
  → task.terminal → JOB_EVENT（可多次 wake）
  → Agent turn+: 按 task/artifact 对比；用户再选改
```

## Implementation anchors

| 层 | 现状 |
|---|---|
| Agent 单路（**MVP 主路径**） | `submitAgentImage` + `run-desk-generate.ts` |
| 串行卡点 | `executionMode: "sequential"` on generate tools |
| Wake 白名单 | `WAKEABLE_JOB_KINDS = generate_from_desk` only |
| accept vs acceptBatch | 仅 `accept` 写 threadId/runId |
| HTTP batch（设计师） | `AssetBatchSubmissionService` — **非 Agent 默认路径** |
| 并发配额 | `TASK_PROJECT_IMAGE_CONCURRENCY`（Worker）；unfinished 硬顶在 accept |

## Doubt log (2026-08-11)

- CLAIM: 「新 batch 工具直接调 AssetBatchSubmissionService + 现有 JOB_EVENT」可满足并发多生图合同。
- Adversarial review：**否决该 CLAIM 的实现形状**。关键：acceptBatch 无 thread、batch_generate 不 wake、origin/guards 漂移、C6 误述、双路径膨胀。
- Cross-model（grok CLI）：**失败** — `API_KEY_DISABLED`；仅单模型 findings。
- RECONCILE：将 MVP 改为 parallel 单工具 fan-out；Agent batch 工具降为后续且必须自建提交面。

## Status

**Implemented (thin MVP, 2026-08-11):**

- `generate_from_desk` / `text_to_image_on_desk` → `executionMode: "parallel"`; `replace_on_desk` stays sequential
- system prompt + tool guidelines: same-turn multi-call, partial success rules
- `[JOB_EVENT_BATCH]` adds `outcome=partial|all_succeeded|all_failed` and stronger partial-success copy
- unit tests green; real dogfood batch (2 ok + 1 unknown model fail) → task-level partial without rolling back successes
