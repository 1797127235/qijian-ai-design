# Agent 工具模块最优改造（对齐《深入理解 AI Agent》Ch4）

**状态：** implemented（2026-08-09）  
**日期：** 2026-08-09  
**宗旨：** 工具定能力上限；异步架构定真实世界能否可靠跑；参数/错误保真。

---

## CLAIM

将砌间 Agent 从「异步 accepted + 模型轮询 get_task」升级为书中的 **异步三件套**：

1. 启动即 `task_id`（已有）  
2. **完成以结构化事件回注轨迹并可选自动续跑**（本改造核心）  
3. 可 cancel（已有 cancelThread）  

并补齐：错误保真、描述边界、幂等语义、禁止盲重试/静默换引擎。

---

## CONTRACT（必须满足）

1. **保真**：`job.error` / HTTP / model 信息不得被二次抹成「任务失败」。  
2. **异步**：tool.execute 禁止 await work；accepted 立即返回。  
3. **事件回注**：job 终态 → 结构化 observation 进入 **pi session 轨迹**（不是只 WS 给前端）。  
4. **续跑策略**：Agent 路径（有 threadId）的 generate_from_desk 终态 → **自动 wake 一轮**；面板 job（无 thread）不 wake。  
5. **互斥**：thread 已有 running chat_run 时 wake **入队**，不并发双 run。  
6. **幂等**：同一 job 终态只 wake 一次（externalId / 标记）。  
7. **get_task**：降级为「用户/模型主动查进度」；指南禁止忙等轮询。  
8. **不静默换引擎**：model 失败不自动 fallback 主站。  
9. **不盲重试**：服务端不对 5xx 自动重跑 generate（与书：无幂等则不盲重试）；用户/面板原卡重试保留。  
10. **KV**：wake 注入的文本是 **user 侧 observation 块**，不改 system 前缀。

---

## ARTIFACT（设计）

### A. Job 完成事件（结构化）

```text
[JOB_EVENT]
source=agent_job
task_id=…
kind=generate_from_desk
status=succeeded|failed|cancelled|interrupted
artifact_id=…   # optional
error=…         # publicJobErrorForAgent，仅失败
model=…         # from input if any
hint=…          # 策略短句
```

### B. Wake 路径

```
runner.finalize
  → emit agent_job_updated (WS，已有)
  → jobWake.enqueue(job)   # 仅 threadId 存在且 kind 在白名单
       → 若 thread 无 running run：立即 sessions.prompt(wakeText)
       → 若 busy：排队，等 run 结束 drain
```

Wake prompt 形态：

```
[系统事件·非用户口令]
下列后台任务已结束。请根据结果向用户简要说明；
成功可 look_at 验收；失败如实说明 error，不要声称已生成；
不要为同一失败自动再次 generate_from_desk（除非用户明确要求重试）。

[JOB_EVENT]
...
```

- `appendPrompt` 使用特殊 externalId：`job-wake:{taskId}` 幂等。  
- 允许极短/固定文案（非空），role=user（协议限制）；前缀标明系统事件防注入。  
- `selectedArtifactIds=[]`；不带附件。

### C. 工具面（ACI）

| 工具 | 类 | 变更 |
|------|-----|------|
| generate_from_desk | 执行 | accepted 文案改为「完成后系统会通知，勿轮询」；保留 model |
| get_task | 感知 | 透传 error；指南：仅用户追问进度时用 |
| look_at / look_at_desk | 感知 | 不变；成功后验收用 look_at |
| cancel | — | 已有 stop→cancelThread；system 说明 stop 会取消生图 |

### D. 非目标（本轮不做）

- MCP 动态发现  
- Proposer–Reviewer 双模型审图  
- 自动 5xx 重试 / 自动换默认 model  
- 子 Agent  

---

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| Wake 与用户消息竞态 | busy 则入队；appendPrompt 409 时 requeue |
| 无限 wake 环 | 仅终态触发；externalId 幂等；hint 禁止自动 regenerate |
| 注入 | 前缀标明系统事件；error 已脱敏 |
| 成本 | 仅 agent 路径；一 job 一 wake |

---

## 实现文件

- `apps/server/src/agent/async-job/job-wake.ts` — 队列 + drain  
- `apps/server/src/agent/async-job/runner.ts` — finalize 钩子  
- `apps/server/src/agent/session-registry.ts` — `promptJobEvent`  
- `apps/server/src/agent/chat-gateway.ts` / `index.ts` — 接线  
- `apps/server/src/agent/tools/generate-from-desk.ts` — 指南  
- `apps/server/src/agent/system-prompt.ts` — 异步策略  
- tests  
