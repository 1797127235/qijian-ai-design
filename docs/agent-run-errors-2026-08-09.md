# Agent 运行错误清单（2026-08-09）

**状态：** 待逐条讨论  
**证据源：** LangSmith 项目 `pi` + 本地 session  
`data/agent-sessions/8fcfa7ef-…/18df67fa-…/2026-08-08T10-04-35-918Z_….jsonl`  
**范围会话：** 项目「别墅设计」`8fcfa7ef-33e7-430c-8ec3-ac631a1b8c2a` · 线程 `18df67fa-9891-46ee-80d8-e287e9a04ecb`  
**对话模型：** `codex2api/grok-4.5-latest`  
**相关：** [system-prompt](../apps/server/src/agent/system-prompt.ts)、[generate tools](../apps/server/src/agent/tools/generate/)、[desk-context](../apps/server/src/agent/desk-context.ts)、[ADR 0013](adr/0013-agent-generate-from-desk.md)

---

## 如何用这份清单

每条错误统一字段：

| 字段 | 含义 |
|------|------|
| 现象 | 用户/观测到的表现 |
| 证据 | 消息或 span |
| 根因假设 | 当前最可能原因（待验证） |
| 分层 | 产品 / 工具契约 / 上下文装配 / 模型行为 / 观测 |
| 严重度 | P0 误导或数据错 · P1 意图失败 · P2 体验差 · P3 观测/卫生 |
| 候选方向 | 不绑定实现，供讨论 |
| 状态 | open / discussing / decided / wontfix |

讨论时建议一次只改一条的「状态 / 根因 / 候选方向」。

---

## 会话时间线（对照）

| # | 用户 | Agent | 结果 |
|---|------|-------|------|
| 1 | 目前桌面状态 | `look_at_desk` + 双线总结 | 基本正确 |
| 2 | 你目前的能力 | 能力长文 | 正确 |
| 3 | 重新生成 A09，用 gpt image2 做中文说明图 | look_at → generate → get_task×3 → look_at | 落 A11，有多处偏差 |
| 4 | 你使用的是什么模型 | 自称 Cursor Auto | **身份错误** |

---

## E1 · 身份幻觉：自称 Cursor Auto

| 字段 | 内容 |
|------|------|
| 现象 | 用户问「你使用的是什么模型」，Agent 答「我是 Cursor 里的 Auto」 |
| 证据 | session line 24；实际 model_change = `codex2api/grok-4.5-latest` |
| 根因假设 | 基座模型把宿主 IDE/路由助手记成自己；system prompt 禁止暴露内部细节，但未禁止「猜身份」，也未给出权威自称 |
| 分层 | 模型行为 + system prompt |
| 严重度 | **P0**（直接撒谎） |
| 候选方向 | A) system 钉死：「你是砌间 AI 设计助手；对话模型名由配置决定，不知则说不知道，禁止声称 Cursor/Claude/Auto」 B) 运行时注入 `AGENT_MODEL` 只读事实 C) 两者都做 |
| 状态 | **decided + fixed**（2026-08-09）：采用 C — `deskSystemPrompt({ agentProvider, agentModel })` 注入权威事实行 + 禁止宿主/IDE 自称；session-factory 传入 config。对用户可答 `provider/model`（配置级，非内部实现细节）。回归：`session-registry.test.ts` E1 cases。 |

**讨论点：** ~~要不要对用户暴露真实 model id？~~ → 已定：可答部署配置的 `provider/model`。

---

## E2 · 用户指定生图模型被静默丢弃

| 字段 | 内容 |
|------|------|
| 现象 | 用户要求「使用 gpt image2」；工具无 model 参数，走主站默认；仅在事后说明 |
| 证据 | user line 9；`generate_from_desk` inputs 仅有 prompt + source_artifact_id；assistant 收尾才提「不能指定引擎」 |
| 根因假设 | 工具契约故意不暴露 model（Agent 固定主站）；未要求「不支持时先确认」 |
| 分层 | 工具契约 + 产品 + 模型行为 |
| 严重度 | **P1**（明确约束被忽略） |
| 候选方向 | A) `generate_from_desk` 增加 optional `model`，路由到已注册网关 B) 保持无 model，但 prompt 强制：用户点名模型时先拒绝/确认再生成 C) UI 设置默认模型，Agent 只读回显 |
| 状态 | **decided + fixed**（2026-08-09）：采用 A + 行为约束。工具可选 `model`（与面板同一 allowlist）；`matchImageModelId` 做空格/大小写归一；未知 → fail（禁 fallback）；未传 → 主站默认。system + tool guidelines 要求用户点名时必须传 model。回归：`generate-from-desk.test.ts` / `image-providers.test.ts`。 |

**讨论点：** ~~Agent 是否共享 model？未知 fail 还是 fallback？~~ → 已定：共享 allowlist；未知 fail。

---

## E3 · 「重新生成 A09」语义 = 新增旁路，未对齐替换预期

| 字段 | 内容 |
|------|------|
| 现象 | 用户说「重新生成 A09」；系统落 **A11**，旧 A09 保留；Agent 有说明但不问是否要替换/归档 |
| 证据 | line 12–22；桌面 objects 10→11；连线 A08→A11 |
| 根因假设 | 产品只有「生成新 effect_image」；无 replace/supersede；「重新生成」口语 ≠ 工具语义 |
| 分层 | 产品 + 模型行为 |
| 严重度 | **P1**（意图可能失败：用户以为 A09 被换掉） |
| 候选方向 | A) 工具增加 `replace_artifact_id` / supersede 关系 B) 不改工具，prompt 要求复述「将新增一版，原 A09 保留，是否继续」 C) 领域层「变体堆」UI，重生成自动进同堆并标 latest |
| 状态 | open |

**讨论点：** 家装工作流里「重做」更常是替换还是并排比较？

---

## E4 · 指代消解误报：A09 与 label「image」的 A07 竞争

| 字段 | 内容 |
|------|------|
| 现象 | 用户明确说 A09 时，`[RESOLUTION]` 仍「无法唯一消解」，候选 A09 + A07（label:image） |
| 证据 | user line 9 末尾 RESOLUTION 块 |
| 根因假设 | 消解器把 utterance 子串/文件名 `image` 与 alias 规则搅在一起；「A09」本应 unique |
| 分层 | 上下文装配 |
| 严重度 | **P1**（规则说不得静默单选；本次模型靠常识绕过，不可依赖） |
| 候选方向 | A) 精确 alias 匹配（`A\d+`）直接 unique，短路其它候选 B) 通用文件名 `image`/`IMG_*` 降权 C) 黄金任务回归 |
| 状态 | open |

**讨论点：** 精确 alias 是否永远最高优先级？多 alias（「A09 和 A10」）规则？

---

## E5 · get_task 忙等轮询（同步对话拖死）

| 字段 | 内容 |
|------|------|
| 现象 | accepted 后连续 `get_task`×3（running→running→succeeded），中间对用户说「还在生成中」 |
| 证据 | lines 14–19；LangSmith tool.get_task ×3，间隔约 5s；整轮 ~71s |
| 根因假设 | 工具描述鼓励查进度；无「不要轮询」硬约束；模型把异步当成同步等待 |
| 分层 | 工具契约 + 模型行为 + UX |
| 严重度 | **P2**（费 token/延迟；任务一长会更糟） |
| 候选方向 | A) prompt：accepted 后立即结束本轮，告知看桌面；禁止循环 get_task B) get_task 加最小间隔/同 run 调用上限 C) job 完成推 WS，Agent 可选「续跑」通知 D) 工具内短 await+backoff（有超时）——与异步哲学冲突，慎用 |
| 状态 | open |

**讨论点：** 产品要「说完就走」还是「等结果再回」？两者 UX 差很大。

---

## E6 · 过规定 prompt：用户一句 → Agent 整版展板文案

| 字段 | 内容 |
|------|------|
| 现象 | 用户：「中文的说明图」；Agent 自拟标题「衣帽间圣所…」、分区/动线/采光/材料全套 A0 结构 |
| 证据 | generate_from_desk prompt（line 12 / LangSmith tool inputs） |
| 根因假设 | system「宽需求先给可执行默认」+ 看了旧 A09 后照搬加重；未确认用户要「轻说明」还是「提案展板」 |
| 分层 | 模型行为 + 产品默认 |
| 严重度 | **P2**（可能过度发挥；也可能正合展板意图——需产品定默认） |
| 候选方向 | A) 默认轻量（主图+中文标题+3 要点），重展板需用户说「展板/提案板」 B) 两档：先问一句 C) 保持现状，从旧版继承结构算合理 |
| 状态 | open |

**讨论点：** 砌间默认偏「快迭代一刀」还是「一次出提案级」？

---

## E7 · look_at_desk 对「桌面状态」是否必要

| 字段 | 内容 |
|------|------|
| 现象 | 用户问桌面状态时，DESK_CONTEXT 已有 Survey 全文，仍先 `look_at_desk` |
| 证据 | lines 3–6 |
| 根因假设 | 模型想「看见」布局；system 允许按需 look_at_desk；未区分「结构化已够」vs「需要空间方位」 |
| 分层 | 模型行为 + prompt |
| 严重度 | **P3**（多一次拼图成本；本次总结质量尚可） |
| 候选方向 | A) 指南：仅 Survey 能答时不要 look_at_desk B) 保持鼓励视觉总览（总览能补 caption 没有的空间感） C) Survey 增强后禁止默认总览 |
| 状态 | open |

**讨论点：** 总览图的边际价值是否值得每轮「状态」类问题都付？

---

## E8 · 物件命名链可读性差（「从 从 image 生成-1 生成-3」）

| 字段 | 内容 |
|------|------|
| 现象 | A09/A11 等 label 叠床架屋；Agent 对用户还好（用 A0x），但 DESK_CONTEXT 噪声大 |
| 证据 | Survey 列表 labels；A11「从 从 image 生成-1 生成-3」 |
| 根因假设 | 生成命名规则递归拼接源 title，源已是「从 … 生成-n」 |
| 分层 | 产品 / 领域命名 |
| 严重度 | **P2**（上下文噪声；指代与展示都变差） |
| 候选方向 | A) 命名模板：`{主源短名} · {intent 截断}` 或 `效果 {n}` B) 用户可改名优先 C) Survey 展示 short_label 字段 |
| 状态 | open |

---

## E9 · 观测：LLM 正文与 usage 在 LangSmith 几乎为空

| 字段 | 内容 |
|------|------|
| 现象 | root/model.turn 的 outputs 多为空；token 常为 0；对话全文主要在本地 jsonl |
| 证据 | LangSmith fetch runs；对比 session usage 有 input/output/cache |
| 根因假设 | tracer 只记结构化工具与 run_status；model 输入输出被 redact/未挂载；usage 未从 pi 事件映射 |
| 分层 | 观测 |
| 严重度 | **P3**（排障靠本地 jsonl，云端难做质量分析） |
| 候选方向 | A) model.turn 挂 truncated 文本 + usage B) 仅 metadata：stopReason、tool 次数 C) 维持现状（隐私/体积） |
| 状态 | open |

---

## E10 · 历史 error：server shutdown 打断 run

| 字段 | 内容 |
|------|------|
| 现象 | 2026-08-08 09:57「目前桌面状态」→ `INTERNAL: server shutdown` |
| 证据 | LangSmith error run `019fe0ce-b5d0-…` |
| 根因假设 | `tsx watch` 热重载或进程重启；run 未优雅取消/续传 |
| 分层 | 运行时 |
| 严重度 | **P2**（开发期常见；生产若滚动发布同样会中招） |
| 候选方向 | A) shutdown 时 cancel run + 用户可见「已中断」 B) 运行中禁止热重载杀进程 C) 可恢复 run（难） |
| 状态 | open |

---

## 建议讨论顺序

1. **E1** 身份（快、P0、偏 prompt）  
2. **E2** 生图 model（产品决策）  
3. **E3** 重新生成 vs 新增（产品决策）  
4. **E4** 指代 alias（可测、可修）  
5. **E5** 异步轮询（UX + 工具指南）  
6. **E6** 默认发挥程度  
7. **E8** 命名  
8. **E7 / E9 / E10** 按需  

---

## 明确「这次做得对」的对照（避免只谈错）

- 主源选 A08 做说明展板（非以旧 A09 为源）合理  
- accepted 不声称完成；succeeded 后 look_at 验收  
- 对用户用 A0x + 中文说明，少甩 UUID  
- 事后承认不能指定 GPT Image 2（虽偏晚）  
- cacheRead 高，稳定 system 前缀设计有效  

---

## E11 · gpt-image-2 上游失败被抹成「任务失败」（Agent 有 model / 面板无 model）

| 字段 | 内容 |
|------|------|
| 现象 | Agent 指定 `gpt-image-2` 连续失败；同 prompt 面板手动生图成功 |
| 证据 | jobs：`42eff242`/`7e78ef68` failed model=gpt-image-2；面板 job `a09ff93a` succeeded model=grok-imagine-image-quality。直连 `openai2api` → HTTP 500 `do_request_failed`；主站 Grok text → 200 |
| 根因 | **不是** Agent 工具挂了：E2 后 Agent 正确路由到 provider-2；该网关对 `gpt-image-2` 上游当前不可用。面板默认主站 Grok，故成功。另：`publicGenerateError` 把 `图像服务调用失败：500…` 抹成「生成失败，请稍后重试」，排障困难 |
| 分层 | 外部网关 + 错误透传 |
| 严重度 | **P1**（用户以为 Agent 坏了；实为指定引擎挂了 + 错误不透明） |
| 状态 | **diagnosed**（2026-08-09）：根因在 openai2api 上游；已改 `publicGenerateError` 保留 HTTP 状态/片段。运维：修 provider-2 或换可用 model；用户侧可先「用默认引擎」 |

---

## E12 · get_task / 状态栏把详细错误抹成「任务失败」

| 字段 | 内容 |
|------|------|
| 现象 | job.error 已是「图像服务调用失败（HTTP 500）…」，Agent 经 get_task 只看到 `error=任务失败` |
| 证据 | `get-task.ts` 原逻辑：非取消类错误一律 `"任务失败"`；`formatJobsStatusBlock` 同样写死 `error=任务失败` |
| 根因 | 过度脱敏：入库已 public 的文案在 Agent 出口被二次抹平 |
| 分层 | 工具契约 / 协议 |
| 严重度 | **P2**（Agent 无法转告真实原因，用户以为「Agent 坏了」） |
| 状态 | **fixed**（2026-08-09）：`publicJobErrorForAgent` 透传截断后的 job.error；get_task + 状态栏共用 |

---

## 变更记录

| 日期 | 说明 |
|------|------|
| 2026-08-09 | 初版：基于当日 thread 四轮对话 + LangSmith |
| 2026-08-09 | E11：Agent gpt-image-2 失败 vs 面板成功；上游 500 + 错误抹平 |
| 2026-08-09 | E12：get_task/状态栏不再抹成「任务失败」 |
| 2026-08-09 | 方案 3 / Ch4：JobWake [JOB_EVENT] 事件回注；禁 get_task 忙等 |
