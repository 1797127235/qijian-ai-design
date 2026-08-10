# 实现计划：H8 双通道写桌统一

**状态：** IMPLEMENTED  

**日期：** 2026-08-07  
**分支：** `codex/canvas-reliability`  
**规格：** [2026-08-07-h8-unified-generate-design.md](../specs/2026-08-07-h8-unified-generate-design.md)  
**相关：** H3 Job 外壳已落地；TODO #8 stop 粒度

---

## 0. 完成定义

| # | 标准 | 验证 |
|---|------|------|
| 1 | 面板 `POST /generate-image` 秒级 `201 accepted + task_id` | 单测 + curl/手测 |
| 2 | pending 卡先落桌，complete 后变图/error | 手测 + 现有 generate 测试扩展 |
| 3 | 同 lockKey 后发 abort 先发（跨通道） | 单测 mock complete |
| 4 | Agent/面板 generate 均可 undo，不双 record | 前端逻辑 + 手测 |
| 5 | 重试 `targetArtifactId` 不新建 history | 手测 |
| 6 | Chat stop 只 cancel 当前 thread jobs，不杀面板 job | 单测 store/runner |

---

## 1. 切片与依赖

```
T1 schema/store ──► T2 路由+runner 面板入口 ──► T3 前端 API/useDeskGenerate
                         │
                         ├──► T4 history/undo（可与 T3 并行后半）
                         └──► T5 stop→thread（可与 T2 同 PR 或紧随）
T1–T5 ──► T6 测试 + harness 文档
```

建议两个 PR：

- **PR1（H8a）：** T1 + T2 + T3 + T5  
- **PR2（H8b）：** T4 + T6 收尾  

或 monorepo 单 PR 按 commit 切。

---

## 2. T1 — Schema + Store

### 2.1 Migration `0016_agent_jobs_thread_nullable.sql`

```sql
ALTER TABLE "agent_jobs" ALTER COLUMN "thread_id" DROP NOT NULL;
```

- drizzle schema：`threadId: uuid("thread_id").references(...)` 去掉 `.notNull()`  
- journal 登记  

### 2.2 Types / Store

| 文件 | 改动 |
|------|------|
| `async-job/types.ts` | `threadId?: string`（DTO 可选） |
| `async-job/store.ts` | `create` 接受 `threadId?: string`；insert 时 undefined → null |
| `async-job/store.ts` | 新增 `listActiveByThread(projectId, threadId)` |
| `async-job/store.ts` | 新增 `listActiveByArtifact(projectId, artifactId)`（互斥 cancel 旧 job） |
| `async-job/runner.ts` | `RunAsyncJobOptions.threadId?`；`cancelThread(projectId, threadId)` |
| `generate-from-desk.ts` | input 增加 `origin: "agent_chat"` |

### 2.3 验收

- 现有 agent async 测试仍绿  
- 新建：create 无 threadId 可读回 `threadId === undefined`

---

## 3. T2 — 面板 HTTP 接 Job

### 3.1 依赖注入

| 文件 | 改动 |
|------|------|
| `http/app.ts` | `HttpDependencies` 增加 `jobs?: AgentJobRunner` |
| `index.ts` | `createHttpApp({ …, jobs })` |
| `routes/desk.ts` | deps 含 `jobs` |

### 3.2 `POST /generate-image` 新逻辑

```
1. 若 !generate || !jobs → 503
2. prepare({ …, source: "canvas_panel", createdBy: "designer" })
3. 同 artifact 上 active jobs → cancelJob 各 id（互斥）
4. jobs.run({
     projectId,
     threadId: undefined,
     kind: "generate_from_desk",
     input: { origin: "canvas_panel", prompt, source_artifact_id, target_artifact_id?, client_op_id },
     prepare: async () => ({ artifactId: prepared.pending.artifact.id }),  // 已 prepare；此处只绑 artifact
     work: async ({ signal }) => complete(prepared, signal) …
   })
5. return 201 {
     status: "accepted",
     async: true,
     task_id: details.task_id,
     artifact, version, object, connection  // 来自 prepared.pending
   }
```

**注意：** 当前 `jobs.run` 内部会再调 `opts.prepare`。两种接法选一：

| 接法 | 说明 |
|------|------|
| **A（推荐）** | 路由先 `prepare`；`jobs.run.prepare` 仅 `setArtifact` 返回已有 id（runner 仍走 prepare 钩子） |
| **B** | 路由不预 prepare；整段放进 `jobs.run.prepare`（与 agent 对称） |

**采用 B** 与 agent 完全对称，幂等仍靠 `clientOpId` 进 `CanvasGenerateService.prepare`。

Agent 路径同步：`generate-from-desk` 的 input 补 `origin: "agent_chat"` + `client_op_id`。

### 3.3 `generate()` 同步方法

- 保留给测试/兼容，或改为 `throw` 提示走 job  
- **推荐：** 保留 `generate()` 仅测试用；生产路由不再调用  

### 3.4 互斥（同 lock 旧 job）

在 `jobs.run` 的 prepare 成功拿到 `artifactId` 后（或 complete 前）：

```
for job in listActiveByArtifact(projectId, artifactId) where id !== newJobId:
  cancelJob(id)
```

或在 `CanvasGenerateService.complete` 开头 abort inflight（已有）+ runner cancel 同 artifact active jobs。

### 3.5 验收

- 路由单测：mock jobs.run 返回 accepted；响应含 task_id  
- prepare 失败：HttpError 404，无 job 行  

---

## 4. T3 — 前端面板

### 4.1 API

`src/lib/api/http.ts` + `types`：

```ts
generateImage(...) => request<{
  status: "accepted";
  async: true;
  task_id: string;
  artifact: { id: string };
  version?: { id: string; status: string };
  object?: DeskLayoutObject;
  connection: { id: string; from: string; to: string };
}>(...)
```

### 4.2 `useDeskGenerate`

```
await api.generateImage(...)
// status === "accepted"
if (!targetArtifactId) history.record({ type: "generate", entry from snap/result, connection })
refreshDesk（或依赖 WS object_changed）
closePanel
clear busySourceId  // 立即
// 不再根据 result.status === "failed" 处理 complete 失败
```

prepare 失败：catch → onError。

### 4.3 验收

- 手测：点生成后输入框立即可用；pending 卡出现；完成后成图  
- TypeScript 无旧 `succeeded` 依赖  

---

## 5. T4 — History 统一（H8b）

### 5.1 问题

- 面板：`useDeskGenerate` 已 record  
- Agent：仅 `object_changed` → refresh，**不** record  

### 5.2 方案

在 **desk 级** 统一处理（避免聊天 session 与 history 耦合）：

| 选项 | 做法 |
|------|------|
| **推荐** | `App.tsx` / 新建 `useDeskJobHistory`：订阅与 chat 相同的 WS（或从 chat emit 上抛），`object_changed` + 新 effect 卡时 record |
| 备选 | `useChatSession` 注入 `history.record` |

**去重：**

```ts
const recordedGenerateIds = useRef(new Set<string>());
function recordGenerateOnce(artifactId, entry, connection) {
  if (recordedGenerateIds.current.has(artifactId)) return;
  recordedGenerateIds.current.add(artifactId);
  history.record({ type: "generate", entry, connection });
}
```

- 面板 accepted 后调用 `recordGenerateOnce`  
- Agent：`object_changed` 且 snapshot 中该 artifact 为 `effect_image`、新建（或 payload.pending 刚出现）、`undoable !== false` → `recordGenerateOnce`  
- 重试（已有 artifactId 在 set 中）：不 record  

### 5.3 Undo 与进行中 job

`applyInverse` generate 已是 `deleteObject`。增强：

- 删前可选：若有 API cancel job by artifact——**第一期可不做**（delete 后 complete 写版本失败即可）  
- 服务端 `complete`：append 前确认 artifact 仍存在；不存在则 failed（已有 best-effort 可加强）

### 5.4 验收

- Agent 生图 → Ctrl+Z 删卡  
- 面板生图 → 不双栈（只一条 generate）  
- 重试失败卡 → past 长度不变  

---

## 6. T5 — Stop 收窄到 thread（TODO #8）

### 6.1 改动

| 文件 | 改动 |
|------|------|
| `store.ts` | `listActiveByThread(projectId, threadId)` |
| `runner.ts` | `cancelThread(projectId, threadId)` |
| `session-registry.ts` | `stop`：`jobs.cancelThread(projectId, threadId)` 替代 `cancelProject` |

保留 `cancelProject` 供 shutdown / 运维。

### 6.2 验收

- 单测：project 下 thread A job + 面板 job(null thread) + thread B job；cancelThread(A) 只动 A  
- 手测：stop 聊天不打断面板生图  

---

## 7. T6 — 测试与文档

### 7.1 测试清单

| 测试 | 位置建议 |
|------|----------|
| store create without threadId | `async-job` 或 store test |
| cancelThread 隔离 | runner/store test |
| desk route accepted shape | `routes` 或 generate 集成 test |
| generate-from-desk input.origin | 现有 tool test 断言 |
| history recordGenerateOnce | 纯函数单测（抽 hook 外） |

### 7.2 文档

| 文件 | 改动 |
|------|------|
| `docs/agent-harness-audit.md` | H8 → **已解决（2026-08-07）**；H3 切片 B 可标完成 |
| `docs/superpowers/specs/2026-08-07-async-agent-tools-design.md` | 非目标「面板暂不改」加删除线 + 链到 H8 |
| `TODOS.md` | TODO #8 完成后勾掉或标 done |
| 本 plan | 状态 → DONE |

---

## 8. 文件级 checklist

### 后端

- [ ] `apps/server/drizzle/0016_agent_jobs_thread_nullable.sql`  
- [ ] `apps/server/drizzle/meta/_journal.json`  
- [ ] `apps/server/src/db/schema.ts`  
- [ ] `apps/server/src/agent/async-job/types.ts`  
- [ ] `apps/server/src/agent/async-job/store.ts`  
- [ ] `apps/server/src/agent/async-job/runner.ts`  
- [ ] `apps/server/src/agent/tools/generate-from-desk.ts`（origin）  
- [ ] `apps/server/src/agent/session-registry.ts`（cancelThread）  
- [ ] `apps/server/src/http/app.ts`  
- [ ] `apps/server/src/http/routes/desk.ts`  
- [ ] `apps/server/src/index.ts`  
- [ ] 相关 `*.test.ts`  

### 前端

- [ ] `src/lib/api/http.ts`  
- [ ] `src/lib/api/types.ts`（若有 Generate 类型）  
- [ ] `src/app/useDeskGenerate.ts`  
- [ ] `src/app/App.tsx` 或 `useDeskJobHistory.ts`（H8b）  
- [ ] 可选：`useChatSession` 只 refresh，record 上移  

### 文档

- [ ] harness audit H8  
- [ ] H3 spec 交叉引用  
- [ ] TODOS #8  

---

## 9. 实现顺序（执行时逐项勾）

1. **T1** migration + types + store create nullable + listActiveByThread/Artifact  
2. **T5** cancelThread + session-registry（早做，防面板 job 被 stop 误杀）  
3. **T2** 注入 jobs + desk 路由 async + agent origin  
4. **T3** 前端 accepted 契约  
5. **T4** recordGenerateOnce + Agent 路径  
6. **T6** 测试全绿 + 文档  

每步后：`npm test`（或仓库既有 server/frontend 测试命令）相关包。

---

## 10. 风险与回滚

| 风险 | 缓解 |
|------|------|
| 旧前端等同步 succeeded | 前后端同 PR；破坏性变更在 dev 分支 |
| thread_id null 破坏 FK 查询 | 所有 list 用 IS NULL 显式处理 |
| 双 history | Set 去重 + 单测 |
| prepare 在 run 内外重复 | 采用对称 B：只在 run.prepare 内 prepare |

回滚：恢复 desk 路由 `generate.generate()`；前端恢复旧 status 联合类型。

---

## 11. 非本计划

- REST `GET /jobs`  
- 表改名 async_jobs  
- H10 rate limit  
- complete 与 undo 的分布式锁（本地 abort 足够）  
