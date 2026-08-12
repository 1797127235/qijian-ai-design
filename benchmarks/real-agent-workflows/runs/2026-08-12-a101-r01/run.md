# A101 Real Workflow Run 01

## 元信息

- 日期：2026-08-12
- Commit：`9d3346a0f3a4d7bf381c3fd57641c47c017aa1c8`（工作区含一处未提交改动：`apps/server/src/agent/context/suffix-budgeter.ts` +15 行，经核对**仅为注释/JSDoc 补充，无行为变更**）
- 文本模型 / 图像模型：文本默认 `codex2api/grok-4.5-latest`（待操作者确认）；图像 `grok-imagine-image-quality`（主站 Grok，另有 grok-imagine-image / grok-imagine-image-pro / gpt-image-2@OpenAI2API 可选）
- Project ID / Thread ID：`2355d371-9827-4a66-8dd5-7e12e912911e`（项目名"流程测试"）/ `64110d0d-3edd-482d-9e11-85169ab5dcf4`（标题"查看这个图片"，08:20 创建）
- LangSmith root IDs：（结束后填）
- 开始 / 结束时间：2026-08-12 08:19 +0800 起（基线指标已存 `metrics-before.prom`，291 行）/ —
- 操作者：liu
- 环境：API 8787 `/ready` OK（postgres/redis/worker 均 true），Worker 9465 `/ready` OK；Grafana/Prometheus 未确认启动（若缺层在结论注明）
- 上传素材：`/home/liu/桌面/cf25764c-e458-4a30-9b7b-6ce8ba335917.png`（1448×1086，A101 图纸：正面立面 + 一层/二层平面图；一层含厨房 13'×12'4"、餐厅、客厅 16'×15'、车库、门厅、flex room；二层含主卧 14'×15' + 主卫 + WIC、卧室 2/3、洗衣房）
- 委托简报：`client-brief.md`（业主提案全文，含家庭构成、风格方向、分空间要求、约束与协作方式；协作方式一节直接写入了 M2/M5/M6/M9 对应的行为期望，作为验收依据）

## 结果

- Verdict：FAIL（操作者提前收尾进入修复；断点 #1 三次复现属"机制断裂"）
- 完成里程碑：7/9（M1–M7 达成；M8 中断恢复、M9 终局汇总未做）
- 稳定轮次缓存命中率：93.4%（33 轮，ΣcacheRead 1,652,864 / Σ(input+cacheRead) 1,770,067）；含冷启动全部 38 轮 84.6%
- Agent runs：16 条全部有终态——completed 13 / failed 3 / stopped 0 / interrupted 0（无遗留 running）
- 工具调用：55 次——succeeded 52 / failed 3（全部为 wake 轮被守卫拦截）
- 异步任务：agent_jobs 48 条全部 succeeded（24 生图 + 24 命名，平均 16s，0 error）；task_batches 0 条；队列无遗留
- 机制性人工介入次数：0（00:35:12 用户纠正"先提取平面再设计"的工序属正常协作裁决，不计入）
- 观测覆盖：16/16 run 有 LangSmith root

## 时间线

| 时间 | 用户目标 | Agent 行为 | 工具 / JOB | 结果 | 证据 |
|---|---|---|---|---|---|
| 08:20–08:24 | M1 建项目、上传 A101 图纸入桌面 | — | POST /api/projects + 上传 + 入桌 | OK（项目"流程测试"，canvas_image `9ee4cd03` 已入桌） | desk API 快照 |
| 08:20:54 | "查看这个图片" | look_at 读 A01 并准确复述图纸结构 | look_at（结果 2.3M chars） | OK | run 67fa5df8 |
| 08:24:07 | 粘贴完整委托简报 | search_tools/skills→load_skill→record_project_memory×5，随后给出整案理解与推进方案 | 8 次工具 | OK，理解与简报一致 | run 2431d3dc |
| 08:25:12 | "按推荐做一套完整提案" | 固化 V1 默认决策入记忆，并行 4 路生图（概念板/客厅/厨餐/主卧） | text_to_image×1 + generate_from_desk×3 | 4 路全成功（A02–A05） | run 4cdf00fe |
| 08:26:42 | JOB wake（批 1） | 逐张 look_at 验收并评价 | look_at | OK | run 9c6b8164 |
| 08:27:31 | "直接把全套做出来" | 补 8 路生图（主卫/WIC/Flex/儿童房×2/洗衣/门厅/客卫） | generate_from_desk×8 | 全成功 | run fa86e8d2 |
| 08:28:29–08:29:35 | 两次 JOB wake | 验收汇报；**第二次 wake 尝试 record_project_memory 被守卫拦截 → run 判 failed**，用户看到"任务执行失败：任务执行失败" | look_at×2 / record_project_memory failed | **断点 #1 首现** | runs c63bc20b / c4aa61b9 / cda194c0 |
| 08:35:12 | 用户纠正工序：应先提取两层平面→彩平→再设计 | 接受裁决，承认流程问题，写入项目流程记忆，改为提取平面 | record×2 + generate×2 | OK（A14/A15 线稿） | run af526f8d |
| 08:35:57–08:36:40 | 两次 JOB wake | look_at 验收 A14/A15 并主动列出与原图小差异 | look_at×2 | OK | runs 0061cd2f / e3693bbb |
| 08:43:09 | 用户要求出彩平后整理桌面 | 提交 2 路彩平；声明整理只能靠删除（无拖拽重排 API），给出保留主线方案 | generate×2 + search_tools | 彩平成功；**缓存崩塌：本轮 turn1 起 75,720 tokens 冷读**（断点 #2） | run 121c163f |
| 08:44:00 | JOB wake（彩平批） | 验收彩平后**尝试 remove_from_desk 清理被守卫拦截 → run 判 failed**，用户再见"任务执行失败"；本轮 turn0 又 79,136 tokens 冷读 | look_at / remove_from_desk failed | 断点 #1、#2 复现 | run 5622e506 |
| 08:44:53 | "清理桌面然后重新生成" | 删除旧跳步图 11 张（A03–A13），按彩平重出 8 张效果图 | remove×2 + record×1 + generate×8 | 全成功 | run 38c58ea6 |
| 08:46:32–08:47:29 | 两次 JOB wake | 逐批 look_at 验收、对照彩平点评；**最后一次 wake 再尝试 record_project_memory 被拦 → run failed + "任务执行失败"** | look_at×2 / record failed | 断点 #1 第三次 | runs 0448141f / c1eeefd9 |

## 连续性检查（截至 08:47 快照）

- 已确认事实是否保持：是——风格（Warm Modern Organic）、家庭构成、工序裁决均写入 project_memories，后续生图统一沿用 A02 概念板体系；08:35 的工序纠正被显式承认并执行到底（删旧图、按彩平重生）。
- 被否方向是否再次出现：暂未观察到（"直接散点出图"的旧工序未再使用）。
- 中断恢复后是否知道下一步：未测（M8 未做）。

## 断点

| # | 时间 | 严重度 | 现象 | 期望 | 首个异常 run / turn / tool | 是否机制问题 |
|---|---|---|---|---|---|---|
| 1 | 08:28:50 / 08:44:00 / 08:46:58（3/3 次复现） | 高 | JOB wake 轮里 Agent 想做副作用操作（record_project_memory×2、remove_from_desk×1），被守卫"当前轮次用于读取并汇报后台任务结果"拦截 → 工具 failed → **整个 run 判 failed** → 用户看到裸错误消息"任务执行失败：任务执行失败"（实际后台任务全部成功，消息严重误导） | wake 轮应能完成汇报闭环：要么放开无副作用的记忆写入，要么守卫软失败且不影响 run 终态；用户不该看到内部守卫错误 | run c4aa61b9 / turn0 / record_project_memory | 是 |
| 2 | 08:43:09–08:44:01 | 中 | 缓存连续两轮崩塌：run 121c163f turn1 冷读 75,720、run 5622e506 turn0 冷读 79,136（cache_read=128），随后恢复；全会话 4 次冷读合计 182,670 tokens，占全部 input 的 60%。**已归因（见下方"断点 #2 归因"）：mid-run 工具激活改变 provider-visible tools[] 是主因，另有 wake 边界的残余未定性因素** | 按 V2 目标架构固定工具内核，发现/权限只走 TurnContext+CapabilityGate，provider-visible tools[] 字节级稳定 | run 121c163f turn1（08:43:41 前后） | 是（已归因主因） |
| 3 | 08:29:24 等 | 低 | 失败 run 的用户可见文案是"任务执行失败：任务执行失败"（重复包装），且该消息排在 08:29:04 正常消息之前——history 导出中消息顺序非严格时间序 | 错误消息单次、可读；消息列表按时间排序 | run c4aa61b9 的 assistant 消息 | 是（展示层） |
| 4 | 08:44:53 起 | 低 | 删除 A03–A13 后新效果图复用 A07/A08/A09/A10 等编号，版本/编号关系与删除前冲突 | 编号不复用，验收门槛"版本关系可解释" | run 38c58ea6 的 generate 批 | 是（命名策略） |

## 断点 #2 归因（2026-08-12 09:40 完成）

**证据路径**：LangSmith 不存 prompt 输入（llm run 的 inputs/outputs 为空，仅留 usage）→ 改用本地会话持久化文件 `data/agent-sessions/2355d371…/64110d0d…/2026-08-12T00-20-54-771Z_….jsonl`，逐帧提取 `<system_context_frame>` 的 `seq / tools epoch / active 工具列表`，与 `chat_model_turns` 的 38 轮 token 表对齐（一 run 一帧，16 帧 ↔ 16 run）。

**帧序列揭示的工具纪元变迁**：

| 帧/run | epoch | 工具集变化 | 对应冷读 |
|---|---|---|---|
| seq1–2（67fa5df8 / 2431d3dc turn0） | 1 | 基准 4 件 | — |
| 2431d3dc turn0 调 `search_tools` → turn1 | 1→2 | +search_skills/load_skill/inspect/record/forget_project_memory | **turn1 冷读 7,138（128 命中）** |
| seq3（4cdf00fe）turn0 激活生图工具 → turn1 | 2→3 | +generate_from_desk/text_to_image_on_desk | turn1 命中仅 16%（2,176/13,816）；turn2 回暖 87% |
| seq4（9c6b8164，首个 wake） | 3 | 同上新工具集首现于 wake | **turn0 冷读 20,676（128 命中）** |
| seq5–12 | 3 | 稳定 | 全部正常命中（84–97%） |
| 121c163f turn0 调 `search_tools`（"查桌面整理能力"）→ turn1 | 3→4 | +remove_from_desk/forget，−search_skills/load_skill | **turn1 冷读 75,720（128 命中）** |
| seq13（5622e506，wake） | 4 | 新工具集首现于 wake | **turn0 冷读 79,136（128 命中）**，turn1 回暖 97% |
| seq14–16 | 4 | 稳定 | 全部正常命中（92–98%） |

**结论**：

1. **主因（已证实，经对抗审查修正）**：发现式工具激活通过 `setActiveToolsByName` 同时改变两处 provider-visible 内容——tools[] 参数 **和 system prompt**（pi 的 `_rebuildSystemPrompt` 把每个 active 工具的 `promptSnippet`/`promptGuidelines` 拼进 system，Qijian 全部工具都定义了这两样；Qijian 并未设置 `_systemPromptOverride`）。system prompt 位于前缀第 0 位，单独就足以解释 cache_read=128。激活集一变，system+tools 双段同时失配 → 下一轮全冷读；工具集稳定后立即回暖。r01 全部 4 次大冷读都与 `toolEpoch` 递增精确对齐，无一例外。`docs/agent-context-cache-v2-architecture.md` §4.1 事先预言了这一机制（"执行权限变化与缓存前缀变化绑在一起"），r01 数据为其补了实测证据。
2. **残余未定性**：5622e506 turn0 与 121c163f turn1 同为 epoch-4 工具集且轨迹追加式，理论上应命中却全冷——存在第二个 wake 边界因素（候选：wake 投递路径重建会话导致历史字节漂移、或 codex2api 网关侧缓存丢失；`cache_write` 恒为 0，网关缓存语义不透明）。此外工具集不变时偶发只保住约 1,792 tokens 的小块命中（≈system 段），同样指向网关行为。
3. **排除项**：TTL（2431d3dc turn0→turn1 仅 12s 也冷）；桌面/记忆/任务状态变化（全部走帧尾部 delta 注入，不进前缀，帧证据证实三态 delta/unchanged 工作正常）；轨迹压缩（prompt 尺寸单调增长无收缩）。

**修复方向**（2026-08-12 经怀疑驱动审查修订，替代最初"V2 §4 全量落地"版）：

1. session 创建时固定激活全部现有产品工具（14 件，不含 env 门控的 debug）；`search_tools` 降级为纯推荐，运行路径不再调用 `setActiveToolsByName` → system+tools 整个 epoch 字节稳定；契约变更才升 epoch。
2. CapabilityGate 不动（继续按名决策，含 r01 的 wake 写记忆放开）；Working Set 裁剪删除，观测层 fingerprint 保留、workingSet 变常量。
3. system prompt 一次性重写并冻结（删除"缺能力先 search_tools"指引），明确承认这是契约变更：desk-golden 与 tool-activation/search-tools/session-tool-state 相关测试同步重写。
4. `search_capabilities`/`invoke_capability` 推迟到第一个真低频能力出现时再引入；届时低频定义不进 SDK 注册表/allowlist（防 `_refreshToolRegistry` 并回全量）。`render_on_desk` 三合一 union、`memory` action union、`cancel_task` 均不采纳（对缓存目标无贡献且引入新风险）。
5. 存量 session 上线即 epoch+1 全量 resync，接受一次可观测的重新预热。
6. 审查记录：单模型对抗审查 5 高/5 中/3 低全部归档（H1 证伪原提案 C4 事实依据并补全本归因；H2/H3/M4/M5 推动提案简化为"固定全量超集"）；用户跳过跨模型复核。残余 wake 边界因素留待 r02 开指纹日志（`AGENT_LOG_USAGE`）继续采集。

## 最终桌面与方案叙事

- 三个关键空间：均已产出且经 Agent 验收——客厅、厨餐、主卧（08:46 按彩平重生版，连同主卫/女儿房/儿子房/洗衣房/Flex 共 8 张效果图）
- 版本与替换关系：终态桌面 14 件 = 原始图纸 A01 + 概念板 A02 + 一/二层线稿（A14/A15）+ 一/二层彩平（A16/A17）+ 8 张按彩平重生的效果图；旧散点效果图 11 张已删，但新图复用了 A07–A10 编号（断点 #4）
- Agent 两分钟讲述摘要：未做（M9 未达）
- 仍需用户裁决的问题：未收集（M9 未达）

## 结论与下一跑

- 本次最先断裂的环节：断点 #1——wake 轮能力门把策略拒绝当执行失败，run 终态被污染且守卫文案穿透到用户界面（3/3 复现）
- 只修的 Top 1–2：已修断点 #1（三层全修，见下）；断点 #2（缓存崩塌归因）留待下一跑继续观测
- 修复记录（2026-08-12 09:19，提交前工作区改动）：
  - 策略层 `apps/server/src/agent/capability-gate.ts`：wake 白名单放开 `record_project_memory`（`WAKE_READ_TOOLS` 更名 `WAKE_ALLOWED_TOOLS`，桌面变更类仍拦）
  - 判定层 `apps/server/src/agent/tool-result.ts`：`details.error_code === "POLICY_DENIED"` 判为正常返回，不再标工具/ run failed
  - 展示层 `apps/server/src/services/chat/types.ts`：`clientSafeError` 白名单放行守卫文案（含"后台任务结果"）
  - 回归测试 ×3：`capability-gate.test.ts`（wake 可写记忆、仍拦 remove_from_desk）、`tool-result.test.ts`（POLICY_DENIED 非业务失败）、`chat-service.test.ts`（failed run 原文透出守卫文案）；修复前 3 测试全红（精确复现"任务执行失败：任务执行失败"），修复后 `npm test` 543 绿 + `build:server` 通过
- 下一次复测范围：r02 同场景全里程碑重跑（含 M8 中断恢复、M9 终局汇总），重点验证 wake 轮能记笔记、不再出现"任务执行失败"误导消息，并继续采集断点 #2 的缓存 cohort 数据
