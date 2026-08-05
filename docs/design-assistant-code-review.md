# 画布模块「设计助手」代码审查与市场对标

> 审查日期：2026-08-05
> 审查分支：`codex/canvas-reliability`
> 审查提交：`58018b6121be`
> 审查范围：设计助手侧边栏、WebSocket 聊天链路、Agent 会话、画布工具、Artifact 写入与效果图生成
> 审查性质：初始结论来自只读审查；文末状态持续记录后续修复

## 1. 结论

当前「设计助手」更接近可演示原型，不建议直接用于真实设计项目或多人环境。

服务端持有 Artifact、Artifact 版本不可变、画布布局与设计事实分离，这些基础方向是合理的。但围绕助手的安全边界、会话一致性、连接恢复、自动执行保护、事务写入、撤销和局部编辑均未形成可靠闭环。

发布前至少需要解决：

1. 项目身份、归属和接口授权；
2. 持久化聊天线程与 WebSocket 重连；
3. 可恢复的任务状态和正确的 Agent 生命周期；
4. 默认完全访问下的费用限制与真正可用的撤销；
5. 工具调用的事务性、幂等性和 Artifact Schema；
6. 画布选区上下文、生成物定位与局部编辑。

### 前端第一轮修复状态（2026-08-05）

本报告形成后，已完成第一轮纯前端修复：

- WebSocket 连接状态、指数退避重连和有界发送队列；
- 连接中、重连中和离线状态展示；
- 使用 `agent_settled` 判断任务真正结束；
- 按 `toolCallId` 跟踪多个活动工具并显示中文动作；
- 增加基于现有 rollback API 的“撤销上次修改”入口；
- 完整桌面刷新增加请求序号，防止旧响应覆盖新状态；
- Agent 修改后自动定位并高亮对应画布对象；
- 修复流式消息强制滚动、换行和链接显示；
- 增加连接状态和任务状态的无障碍语义；
- 助手折叠偏好持久化，并改进平板与窄屏布局；
- 新增 WebSocket 排队、重连和主动关闭测试。

仍依赖后端才能完整解决：服务端任务恢复、身份授权、其余事务工具、Artifact Schema、图片来源访问控制、选区协议和局部图片编辑。

### 运行中任务停止修复状态（2026-08-05）

已确认并修复“助手任务无法停止”：

- 忙碌态的发送按钮改为可点击的停止方块；
- WebSocket 新增按 `threadId` 隔离的 `stop` 指令与停止结果事件；
- 服务端调用 SDK 已提供的 `AgentSession.abort()` 终止当前运行，不会误停其他对话线程；
- 新增界面忙碌态、WebSocket 停止指令和 Session abort 的回归测试。

任务和 Tool Call 状态现已持久化；服务进程重启后，未完成任务与工具会标记为 `interrupted`，但不会自动续跑，以免重复执行已部分完成的画布写操作。

### 会话持久化修复状态（2026-08-05）

已完成本问题的消息与上下文主链路：

- 新增 PostgreSQL `chat_threads`、`chat_messages` 表和迁移；
- 用户消息先落库，再提交给 Agent；使用客户端消息 ID 防止重连重复提交；
- 助手完整回复在 `message_end` 后落库，并以服务端消息 ID 广播；
- 前端进入项目时从 HTTP 接口恢复历史，不再依赖浏览器内存缓存；
- 支持一个项目创建、查看、切换和删除多个独立对话；每个线程使用独立 AgentSession 和恢复上下文；
- 同项目多标签页通过 WebSocket 同步服务端消息并按 ID 去重；
- 服务重启后，新 AgentSession 会读取最近 80 条历史并注入上下文；
- 已真实验证页面刷新后恢复记录，以及后端重启后能回答上一轮会话内容。

运行中的 Task 和 Tool Call 已持久化；服务中途重启时，正在执行的任务和工具会保留参数与已有结果并标记为 `interrupted`。未完成的流式回复不会续传，任务也不会自动重放。

### Tool Call 持久化修复状态（2026-08-05）

已确认并修复“工具执行只广播、不落库”：

- 新增 PostgreSQL `chat_tool_calls` 表并关联 `chat_runs`；
- `tool_execution_start` 幂等保存 `toolCallId`、工具名、参数和开始时间；
- `tool_execution_end` 保存成功/失败状态、结构化结果、错误、结束时间及 SDK/工具返回的费用信息；
- 参数和结果序列化设置 250,000 字符上限，超限内容保留截断标记和预览；
- 停止、失败或服务重启时，仍处于 `running` 的工具调用会同步转为终态；
- Chat History 接口按时间顺序返回最近 100 条 Tool Call，后续可以直接实现执行步骤时间线。

费用字段已经具备持久化能力；具体工具或上游 SDK 未返回费用时保持为空，不伪造估算值。

### 默认完全访问决策（2026-08-05）

产品决定移除审批机制，助手默认直接执行所有画布工具。前后端审批队列、批准/拒绝消息、权限切换入口、`PermissionGate` 及数据库权限字段均已删除。原“审批刷新后丢失”问题因此不再适用，风险转为需要 Stop、费用配额和可恢复撤销来约束自动执行。

## 2. 审查范围与关键代码

| 模块 | 主要文件 |
|---|---|
| 设计助手界面 | `src/desk/ChatPanel.tsx`、`src/desk/desk.css` |
| 前端事件编排 | `src/app/App.tsx` |
| WebSocket 客户端 | `src/lib/api.ts` |
| WebSocket 服务端 | `apps/server/src/agent/chat-gateway.ts`、`apps/server/src/index.ts` |
| Agent 会话 | `apps/server/src/agent/session-registry.ts`、`apps/server/src/agent/system-prompt.ts` |
| Agent 工具 | `apps/server/src/agent/tools/*.ts` |
| Artifact 与画布状态 | `apps/server/src/services/artifact-service.ts`、`desk-state-service.ts` |
| 图片与提案导出 | `apps/server/src/services/image-generator.ts`、`export-service.ts` |

## 3. P0：上线阻断问题

### 3.1 项目与智能体接口没有身份、归属和授权校验

位置：

- `apps/server/src/index.ts:36-40`
- `apps/server/src/http/app.ts:49-116`
- `apps/server/src/db/schema.ts:5-22`
- `docs/product-discovery-grill.md:397-401`

WebSocket 升级只从 URL 中提取 `projectId` 后直接连接，REST API 也没有认证和资源归属校验。数据库中的 `projects` 和 `artifacts` 没有产品文档承诺的 `owner_id`。

调用方只要能够访问服务，就可以：

- 列出和读取全部项目；
- 修改或删除项目与 Artifact；
- 向项目智能体发送 Prompt；
- 直接触发写操作；
- 发起可能产生费用的效果图生成和导出。

WebSocket 还缺少 Origin 校验、Prompt 长度限制、消息速率限制和费用配额。`ws` 默认允许较大的消息载荷，会进一步放大内存、模型费用和拒绝服务风险。

建议：

1. 即使暂不建设登录，也应恢复预置开发设计师及 `owner_id`；
2. HTTP 与 WebSocket 共用同一个授权中间件；
3. WebSocket 握手校验 Origin、用户和项目成员关系；
4. 增加消息大小、频率、并发任务和图片费用限制；
5. 自动写操作记录发起人、任务和费用，不能只按项目广播。

## 4. P1：高优先级正确性问题

### 4.1 聊天界面与模型记忆发生分裂

状态：**已修复。消息历史按原始 `user/assistant` 角色恢复；每次 Prompt 的 `running/completed/failed/stopped/interrupted` 状态也已持久化。服务重启后遗留任务会标记为 `interrupted` 并在历史中提示用户重新发送，不会冒险自动重复执行可能已部分完成的画布操作。**

位置：

- `src/app/App.tsx:88-109`
- `apps/server/src/agent/session-registry.ts:30-50`
- `apps/server/src/agent/session-registry.ts:71-80`

前端每次进入项目都会清空 `chatItems`、`streaming` 和 `pending`，服务端却会从 `sessions` Map 中复用旧 AgentSession。

这会产生两种相反状态：

- 切换项目后再回来：界面看起来是新会话，模型仍受不可见旧指令影响；
- 服务重启后：界面和模型同时丢失历史，但没有任何提示。

用户无法判断助手当前记得什么，容易出现“为什么它还在执行上一次要求”的信任问题。

建议建立服务端持久化 Chat Thread，包括消息、任务、工具调用和最终状态；前端进入项目时恢复线程，或明确创建一个全新的会话。

### 4.2 WebSocket 没有可靠的连接状态机

位置：

- `src/lib/api.ts:98-115`
- `src/app/App.tsx:289-295`

客户端只有 `onmessage`，没有处理：

- `onopen`；
- `onerror`；
- `onclose`；
- 自动重连；
- 待发送消息队列；
- 心跳与连接超时；
- 重连后的状态恢复。

`ready()` 已定义但没有使用。连接仍处于 `CONNECTING` 或已经关闭时，`socket.send()` 会失败；界面却已经加入用户消息并进入 `busy` 状态，可能永久显示“正在处理”。

建议显式建模 `connecting / connected / reconnecting / offline`，发送前检查状态，离线消息进入有界队列；重连时同步线程游标和活动任务。

### 4.3 使用了错误的 Agent 完成事件

位置：

- `src/app/App.tsx:110-130`

当前代码在 `message_end` 或 `agent_end` 时清除 `busy`。但当前 pi SDK 明确说明：`agent_end` 只代表一次底层运行结束，其后仍可能自动重试、压缩后重试或继续处理 Follow-up；真正完全结束的事件是 `agent_settled`。

另外，当前活动状态只有一条：

- 新的 `tool_execution_start` 会替换旧活动；
- 任意一个 `tool_execution_end` 会清空全部活动；
- 并行工具时状态必然错误；
- 界面显示的是内部工具名，而不是用户可理解的动作与目标。

建议按 `runId/toolCallId` 管理状态，用 `agent_settled` 结束任务，并保留每个工具的开始、进度、结果和错误。

### 4.4 默认完全访问缺少执行保护

状态：**审批机制已按产品决策删除，原审批并发与刷新问题不再适用。**

助手现在会直接执行移动、编辑、确认、图片生成和导出工具。仍需补充停止运行、费用配额、操作日志、幂等保护和可靠撤销，避免误操作或重复生成带来数据及成本风险。

### 4.5 工具写入不是原子操作，会留下半成品

状态：**部分修复。`create_direction_set` 已经将 Artifact 创建与画布布局写入合并到同一数据库事务；批量理解便签、效果图和幂等保护仍待解决。**

位置：

- `apps/server/src/agent/tools/create-understanding-notes.ts:39-47`
- ~~`apps/server/src/agent/tools/create-direction-set.ts:35-41`~~（已修复）
- `apps/server/src/agent/tools/generate-effect-image.ts:39-49`
- `apps/server/src/agent/tools/shared.ts:39-48`

多个工具都采用“创建 Artifact，再单独摆放到画布”的方式。设计方向工具已改用 `ArtifactService.createPlaced()` 在一个事务中完成两步；其余上述路径仍需收敛。

可能结果：

- Artifact 创建成功，摆放失败，形成画布上不可见的孤儿数据；
- 多便签任务执行一半后失败，留下部分结果；
- Agent 认为工具失败并重试，导致重复 Artifact；
- `object_changed` 在批量过程中触发多次刷新，前端可能看到中间状态。

建议把一次工具调用建模为带 `commandId` 的事务命令；数据库事务内完成 Artifact 与 desk_state 写入，并用幂等键防止重试重复执行。外部图片生成无法纳入数据库事务时，应使用明确的任务状态和补偿清理。

### 4.6 产品承诺可回滚，但用户无法撤销

位置：

- `apps/server/src/http/app.ts:83-86`
- `apps/server/src/agent/tools/index.ts:16-30`
- `src/lib/api.ts:65-89`
- `CONTEXT.md` 中“助手执行”定义

后端存在 `/api/artifacts/:id/rollback`，但：

- 前端 API 没有暴露 rollback；
- Agent 工具集中没有撤销工具；
- ChatPanel 没有撤销按钮；
- 工具结果没有关联可撤销的版本或命令；
- `object_changed.undoable` 在前端类型和界面中被忽略。

因此“默认完全访问，但所有修改可回滚”的产品承诺目前不成立。

建议为每个写命令返回 `commandId`、前后版本和可撤销期限，在工具结果与画布提示中提供一键撤销；撤销必须同时处理 Artifact 版本和布局变化。

### 4.7 已确认内容无法继续迭代

位置：

- `apps/server/src/agent/tools/edit-payload.ts:27-39`
- `src/desk/nodes.tsx:58-65`

`edit_payload` 拒绝修改 confirmed Artifact，但工具集中没有“从确认版本派生新草稿”的动作。原 Brief 模块已按产品决策完整移除，不再属于此问题范围。

设计师一旦确认理解便签或设计方向，后续客户反馈仍无法通过助手或界面继续修改，只能绕过正常产品流程直接调用 REST API。

建议增加 `create_draft_from_version` 或统一的 `revise_artifact`：以确认版本为父版本创建草稿，保留来源、变更原因和确认状态，不覆盖历史确认版本。

### 4.8 Artifact payload 缺少类型级 Schema

位置：

- `apps/server/src/http/app.ts:24-31`
- `apps/server/src/agent/tools/edit-payload.ts:20-24`
- `apps/server/src/services/artifact-service.ts:115-133`

HTTP 与 Agent 工具都允许任意 `Record<string, unknown>`。只有在状态为 confirmed 时检查少量必填字段，草稿几乎没有结构约束。

风险包括：

- Agent 生成无法渲染的 payload；
- 任意字段被整体替换或丢失；
- `edit_payload` 没有保留当前 `inputRefs`，破坏来源链；
- 未验证 `space_id`、图片 URL、方向结构和版本引用；
- 前端用大量静默 fallback 掩盖数据错误。

建议为每个 Artifact 类型建立共享的 Zod/TypeBox Schema，在 HTTP、Agent 工具、服务层和前端映射中复用；草稿可以允许不完整，但不应允许结构无效。

### 4.9 效果图不是可复现资产，并存在服务端请求风险

状态：**部分修复。效果图现在会下载并校验 JPG、PNG 或 WebP，限制为 20MB，写入 FileStorage 后将项目文件 URL 和 `file_id` 保存到 Artifact。主机白名单与私网地址防护仍待解决。**

位置：

- `apps/server/src/agent/tools/generate-effect-image.ts:34-48`
- `apps/server/src/services/image-generator.ts:26-35`
- `apps/server/src/services/export-service.ts:27-28`
- `apps/server/src/services/export-service.ts:53-56`

旧实现在图片服务返回 URL 后直接把它存入 Artifact。现已改为下载到 FileStorage，并由 `stored_files` 记录内容哈希、字节数、媒体类型和稳定文件 ID；Artifact 同时保留 `source_url` 用于追溯。

后果：

- ~~外链过期后历史效果图丢失；~~ **已通过项目文件归档解决。**
- ~~外链内容变化后同一 Artifact 展示不同内容；~~ **Artifact 现在展示已归档副本。**
- ~~提案包无法稳定复现；~~ **导出现在使用项目文件 URL。**
- 生成阶段的服务端下载仍缺少主机白名单和私网地址拦截，仍可能形成 SSRF 或内网探测风险。

建议只接受受控 HTTPS 来源，下载后验证媒体类型、尺寸和大小，保存到 FileStorage，并在 Artifact 中记录 file ID、内容哈希、模型、Prompt、输入版本和生成参数。

### 4.10 设计流程规范互相冲突

位置：

- `docs/adr/0008-design-system-confirmation-gate.md`
- `docs/adr/0009-design-constraint-package-contract.md`
- `docs/implementation/agent-backend-redesign.md`
- `apps/server/src/agent/tools/generate-effect-image.ts:18-38`

已接受的 ADR 要求：确认设计方向后，先生成和确认 `design_system` 方案约束包，再进入效果图生成。

当前实现文档却明确删除了 `design_system`，实际工具只检查空间地图和设计方向，然后把整份 Artifact 快照 JSON 发给图片模型。

这使材料、预算、禁用项、家具语言、灯光和跨空间一致性没有稳定的生成基线，容易导致多空间效果图风格漂移。需要正式废弃旧 ADR 并说明替代方案，或恢复方案约束包确认门。

### 4.11 画布刷新存在竞态

位置：

- `src/app/App.tsx:79-85`
- `src/app/App.tsx:141-143`

每个 `object_changed` 都会启动一次完整 `refreshDesk`，没有请求序号、取消或合并。批量工具会短时间触发多个请求，旧请求可能晚于新请求完成并覆盖较新的 UI 状态。

建议至少增加 refresh generation/AbortController；更合适的方式是让事件携带命令版本或 desk revision，前端只接受比当前 revision 新的快照，并对批量事件进行合并。

### 4.12 Agent 输入缺少不可信内容边界

状态：**部分修复。system prompt 已移除项目名称、Artifact payload 和拼接的聊天历史，并明确声明项目与历史内容是不可信数据。工具返回的项目内容仍会进入模型上下文，服务端付费和高风险动作策略仍待完善。**

位置：

- `apps/server/src/agent/system-prompt.ts:3-28`
- `apps/server/src/agent/tools/read-desk.ts:6-13`

旧实现会将项目资料、Artifact payload 和最近聊天历史直接拼入系统提示，导致原本的用户消息在 Session 恢复后获得 system 优先级。这些动态内容现已从 system prompt 移除，历史消息由 SDK SessionManager 按原始角色恢复。

在默认完全访问模式下，项目资料中的提示注入文本仍可能诱导 Agent 修改草稿、生成付费图片或导出资料。

建议将项目内容放入结构化、不可信数据边界；系统规则明确禁止遵循项目内容中的指令；服务端策略层仍需校验工具动作，不能只依赖模型遵循提示。

## 5. P2：交互、可访问性与性能问题

### 5.1 对话展示

- `ChatPanel` 在每个流式 token 到来时强制滚到底部，用户无法回看长回复；
- ~~不支持 Markdown、段落、列表、表格和代码块；~~ **已修复：助手消息支持安全 Markdown 与 GFM 渲染。**
- ~~换行会被普通 `div` 折叠；~~ **已修复：段落和换行按 Markdown 语义显示。**
- ~~提案 PDF URL 显示为不可点击文本；~~ **已修复：安全链接可点击并在新窗口打开。**
- 没有复制、重新生成、反馈或编辑消息操作；
- 没有消息时间、运行状态和工具结果关联。

### 5.2 Composer

- ~~忙碌和离线时仍可发送；~~ **已修复：忙碌时输入不会重复提交，离线时禁止发送。**
- ~~没有停止按钮；~~ **已修复：忙碌态显示停止按钮并调用服务端 `AgentSession.abort()`。**
- 没有附件、拖放、粘贴图片或参考资料；
- 没有 `@空间`、`@Artifact` 或当前选区上下文；
- 没有快捷动作、Prompt 模板和历史 Prompt；

### 5.3 画布联动

- 新生成对象不会自动定位、聚焦或高亮；
- `object_changed.artifactId` 没有用于增量定位；
- Agent 自己决定绝对 `x/y`，没有布局、碰撞和视口边界算法；
- 新对象可能落在屏幕外或覆盖已有对象；
- 用户无法从回复跳转到对应空间、方向卡或效果图；
- 没有展示 Agent 当前正在查看或修改哪个画布对象。

### 5.4 响应式布局

位置：`src/desk/desk.css:194-260`、`441-445`

- 助手面板固定宽度 506px，不能调整；
- 720px 以下面板宽度接近整屏，画布只剩很窄区域；
- 721-1024px 没有平板布局；
- 折叠状态、宽度和用户偏好没有持久化；
- 不适合触屏设备上的画布和聊天切换。

### 5.5 可访问性

- 流式消息和执行状态需要继续验证读屏体验；
- 消息区没有日志语义；
- 键盘焦点不会在展开、折叠后合理移动。

### 5.6 性能与扩展性

- Agent 被要求频繁读取整张桌面，而不是相关选区；
- `read_desk` 将全部 Artifact JSON 作为文本返回，画布变大后会快速增加上下文和费用；
- 每个 `object_changed` 都重新请求完整桌面；
- **已修复：** 删除对话或项目时会先终止运行中的任务并释放对应 Session；无人使用的 Session 会在空闲 30 分钟后自动释放，服务关闭时也会统一清理。WebSocket 断开后为支持重连不会立即销毁 Session；
- 没有线程、任务或图片生成的并发上限。

## 6. 与主流侧边栏设计助手的差距

### 6.1 市场基线

#### Figma Agent

官方资料：<https://help.figma.com/hc/en-us/articles/37998629035799-Work-with-the-Figma-agent-in-design-files>

已提供：

- 选中画布图层后直接发起 Agent；
- 画布内 Prompt 和持久侧边栏两种入口；
- 多个 Prompt 并行运行；
- 线程列表、新会话和历史恢复；
- 连接设计系统库；
- 用 `@` 引用组件、变量和样式；
- 文件与图片附件；
- 查看执行步骤；
- Stop 和 Undo；
- 批量编辑、图片编辑和设计反馈。

#### Miro Sidekicks

官方资料：

- <https://help.miro.com/hc/en-us/articles/30139627329042-Sidekicks>
- <https://help.miro.com/hc/en-us/articles/33881743175954-Sidekicks-evolve-AI-creation-in-Miro>

已提供：

- 选择画布对象作为 Prompt 上下文；
- 统一生成文档、图片、原型、幻灯片、便签和表格；
- 知识源连接；
- 聊天历史和跨格式上下文；
- 先迭代、再提交到画布；
- 自定义 Sidekick、模型、指令和 Conversation Starters；
- 主动建议和异步协作。

#### Adobe Express AI Assistant

官方资料：<https://helpx.adobe.com/express/web/ai-assistant/adobe-express-ai-assistant-overview.html>

重点能力：

- 只编辑指定元素、图层或多个资产；
- 不破坏其余设计内容；
- 内联建议与相关手工工具；
- 图片局部编辑和风格化；
- AI 与手工编辑可以随时切换。

#### Canva AI 2.0

官方资料：<https://www.canva.com/newsroom/news/canva-create-2026-ai/>

该版本仍是研究预览，但体现了市场方向：

- 分层、可编辑的生成结果；
- 持续会话上下文；
- 只修改指定对象；
- 长期记忆和品牌智能；
- 外部连接器、Web 研究和后台任务。

### 6.2 能力矩阵

| 能力 | 市场基线 | 当前设计助手 | 优先级 |
|---|---|---|---|
| 画布选区上下文 | 选中对象、`@` 引用 | 每次读取整张桌面 | P1 |
| 持久线程 | 历史、恢复、新会话、删除、搜索 | 已支持多线程、历史和任务/工具状态恢复；缺少搜索，运行中任务重启后标记中断而非自动续跑 | P1（部分完成） |
| 执行控制 | Stop、Undo、重试、提交前迭代 | 已支持按对话停止；仍缺少可靠撤销、重试和提交前迭代 | P1（部分完成） |
| 附件与参考 | 设计、图片、PDF、代码、知识源 | Composer 只有纯文本 | P1 |
| 局部编辑 | 指定图层、对象或蒙版区域 | 整图生成或整体替换 payload | P1 |
| 设计系统 | 组件、变量、品牌或知识引用 | 硬编码提示，约束包被删除 | P1 |
| 任务可见性 | 画布指示器、步骤、并行状态 | Tool Call 已持久化，实时活动已按 ID 管理；缺少历史步骤时间线和画布目标指示器 | P1（部分完成） |
| 结果可控性 | 分层输出、差异预览、确认提交 | 工具直接修改服务器状态 | P1 |
| 协作 | 共享线程、评论、`@` 提及、权限 | 无归属广播，不是真正协作 | P2 |
| 成本治理 | Credits、限额、管理员控制 | 默认完全访问可直接产生费用 | P1 |
| 自定义助手 | 角色、技能、知识、模型 | 单个硬编码设计助手 | P2 |

## 7. 砌间最需要的领域能力

不建议简单复制通用助手的全部功能。针对家装前期提案，优先补齐以下闭环：

1. **选中空间作为上下文**：Composer 明确展示当前 `space_id`、方向、效果图和约束；
2. **参考资料附件**：支持参考图、材料、PDF 和客户反馈，并说明每个附件的用途；
3. **方案约束包**：稳定保存材料、预算、家具、灯光、禁用项和跨空间规则；
4. **生成预览后提交**：先生成候选草稿，在画布旁比较，再采用或放弃；
5. **局部效果图修改**：允许框选区域、写修改要求、保持未选区域；
6. **版本对比与恢复**：展示前后版本、变更原因和一键撤销；
7. **几何与来源提醒**：明确哪些内容来自图纸、用户对话、设计决策或模型推断；
8. **变化定位**：每次 Agent 修改后自动聚焦目标并高亮变化；
9. **成本预估**：图片生成前显示次数、模型和预计费用；
10. **客户反馈转设计决策**：反馈不能直接覆盖确认内容，应先形成待审阅草稿。

## 8. 推荐修复路线

### 阶段 A：安全与可靠性

1. 补充开发设计师、`owner_id` 和统一授权边界；
2. 增加 WebSocket Origin、载荷、速率、并发和费用限制；
3. ~~在已持久化 Chat Thread/Message 的基础上，继续建立 Task 和 Tool Call 数据模型；~~ **已完成：`chat_runs` 与 `chat_tool_calls` 已落库。**
4. 实现连接状态机、自动重连和游标恢复；
5. 使用 `agent_settled` 和按 ID 管理的工具状态；
6. ~~增加会话和 Session 的空闲释放策略。~~ **已完成：对话/项目删除、空闲超时和服务关闭均会释放 Session。**

### 阶段 B：可控执行

1. 工具写入事务化和幂等化；
2. 默认完全访问下展示目标、差异、成本和风险，并设置费用配额；
3. 增加 Stop、Undo、Retry 和从确认版本派生草稿；
4. 为所有 Artifact 建立类型 Schema；
5. 外部图片下载归档并校验；
6. 引入 desk revision，消除刷新竞态。

### 阶段 C：画布原生助手

1. 选区与 `@空间/@Artifact` 上下文；
2. 修改后定位、高亮和变化摘要；
3. Composer 附件、参考图和材料输入；
4. 候选结果比较与提交；
5. 局部效果图蒙版编辑；
6. 可调整侧边栏和响应式抽屉。

### 阶段 D：领域扩展

1. 方案约束包与冲突处理；
2. 材料、品牌和知识库；
3. 多角色助手与可复用工作流；
4. 评论、客户反馈和异步协作；
5. 模型选择、Credits 和管理员治理。

## 9. 测试缺口

当前验证结果：

- `npm test`：13 个测试文件、39 个测试全部通过；
- `npm run build`：通过；
- `npm run build:server`：通过。

但设计助手关键链路仍缺少以下覆盖：

- ChatPanel 发送、滚动和更完整的可访问性（忙碌态停止按钮已有覆盖）；
- WebSocket 连接前发送、断线和重连；
- ChatGateway 消息校验与多连接广播；
- Session 恢复、清理、重启和隐藏历史；
- 并发 Prompt 与并发工具执行；
- 其余工具的部分失败、幂等重试和事务回滚（`create_direction_set` 原子写入已有覆盖）；
- `agent_settled` 生命周期；
- `object_changed` 刷新竞态；
- 效果图主机白名单、私网地址防护和归档失败补偿（媒体类型、大小、归档和稳定导出已完成）；
- Artifact 类型 Schema 与错误 payload；
- Prompt 注入和自动模式策略。

建议优先为状态机、自动工具执行、事务命令和安全边界增加集成测试，再增加浏览器端端到端测试。

## 10. 审查限制

本次完成了静态代码审查、现有测试、前后端构建和主流产品官方资料对标。

浏览器交互实测未执行：本机浏览器 QA 工具尚未完成一次性构建，按工具约束没有自动安装额外依赖。因此本报告中的交互 Bug 来自代码路径、协议状态和生命周期推演；在实施修复前仍应补充桌面、平板、窄屏、断网和多标签页的端到端复现。
