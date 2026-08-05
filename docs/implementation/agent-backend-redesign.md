# 后端重写设计：TS + pi 智能体后端

状态：已实施。前端单画布桌面（`src/desk/`）通过 REST/WebSocket 连接 TS Agent 后端。

## 决策摘要（来自产品拷问）

- 单画布"设计桌面"：项目 = 桌面，客户资料为起点，户型图居中，物件生长式推进
- 移除：6 阶段流程、约束包（design_system）、空间提案卡（space_proposal）
- AI 助手当前直接分析用户文字和附件，不操作桌面数据
- 旧的自定义业务工具已删除，保留空的工具注册边界
- 效果图接图像生成模型；提案包导出 PDF/图片
- 后端整体 TS 重写，弃 Python/FastAPI；agent 底层用 `earendil-works/pi`
- PostgreSQL 保留；Artifact 版本化契约保留

## 技术栈

| 层 | 选型 |
|---|---|
| Agent SDK | `@earendil-works/pi-coding-agent`（主包含 SDK：`createAgentSession` / `ModelRuntime` / `SessionManager` / `defineTool`，同进程嵌入） |
| LLM 抽象 | `@earendil-works/pi-ai`（随主包；自定义 provider 走 `models.json` + OpenAI 兼容端点，Grok 即此接入） |
| HTTP 服务 | Node + Hono（轻、TS 友好） |
| 数据库 | PostgreSQL（沿用 docker-compose），Drizzle ORM |
| 图像生成 | 独立 `ImageGenerator` 接口（gpt-image / 即梦 / FLUX 选一；pi-ai 只管文本 LLM，图像不经过它） |
| 提案包导出 | HTML 模板 + Playwright 打印 PDF/PNG |
| 运行时 | Node 22.19+（pi SDK 运行时要求） |

集成方式选 **SDK 同进程嵌入**而非 RPC 子进程，聊天会话、附件和事件流均由服务端进程直接管理。

## 架构

```
src/desk (React)                apps/server (TS)
┌──────────────┐   WebSocket    ┌─────────────────────────┐
│ Desk + Chat  │ ◄────────────► │ ChatGateway             │
│ (pi agent)   │   REST         │  └─ AgentSession        │
└──────┬───────┘ ◄────────────► │     ├─ pi-agent-core    │
       │                        │     └─ customTools: []   │
       │                        │ ArtifactService (版本化) │
       │                        │ DeskStateService        │
       │                        │ FileStorage（本地文件）  │
       │                        │ ExportService (PDF)     │
       │                        └───────────┬─────────────┘
       │                                    │
       │                              PostgreSQL
```

- **数据平面**：ArtifactService + DeskStateService + FileStorage，纯 CRUD + 版本化，不含 AI
- **控制平面**：每个项目、线程一个 `AgentSession`；恢复持久化聊天记录和附件，`customTools` 当前为空
- 桌面状态（物件位置/旋转/视口）持久化于 `desk_state`，与 Artifact 内容分离（沿用旧"画布布局不改设计事实"原则）

### Session 创建骨架（对齐 pi SDK）

```ts
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true } });
const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  settingsManager,
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noContextFiles: true,
  systemPrompt: deskSystemPrompt(deskSnapshot),
});
await loader.reload();

const modelRuntime = await ModelRuntime.create();
const model = modelRuntime.getModel(agentProvider, agentModel);
if (!model) throw new Error(`未找到 Agent 模型：${agentProvider}/${agentModel}`);
const { session } = await createAgentSession({
  modelRuntime,
  model,
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(),
  settingsManager,
  noTools: "builtin",            // 禁用 read/bash/edit 等文件系统工具
  customTools: createDeskTools(projectId, dependencies), // 当前返回空数组
});
session.subscribe((event) => forwardToWebSocket(event));      // 事件流→前端
```

## 数据模型（Drizzle schema）

保留 Artifact 双表契约，裁剪 artifact_type 集合：

```ts
// artifacts: id, project_id, artifact_type, current_version_id, created_at
// artifact_versions: id, artifact_id, version_no, status(draft|confirmed),
//                    payload(jsonb), input_refs(jsonb), created_by(designer|agent), created_at
```

`artifact_type` 当前集合：

| 类型 | 说明 | 对应桌面物件 |
|---|---|---|
| `space_map` | 空间区域基线（含关键空间★） | 户型图 |
| `understanding_note` | 单条空间理解（拆成多条，钉在空间旁） | 理解便签 |
| `design_directions` | 方向集（3 卡 + selected_direction_id） | 方向草图 |
| `effect_image` | 单张效果图变体（绑定 space_id，adopted 状态） | 照片堆 |
| `proposal_package` | 导出记录（PDF 文件引用 + 叙事顺序快照） | 导出按钮 |

废弃：`design_system`、`space_proposal`、`proposal_canvas`（桌面状态不再是 Artifact）。

新增 `desk_state` 表：`project_id (pk), objects(jsonb: [{artifact_id, kind, x, y, rot, w}]), viewport(jsonb), updated_at`。位置可改，内容不可改。

## 智能体工具状态

原有桌面业务工具实现已删除。`apps/server/src/agent/tools/index.ts` 和 Session 的 `customTools` 注册边界继续保留，但当前注册列表为空；工具事件持久化与前端执行状态 UI 也未删除，供后续重新设计时复用。

## 上下文构造

Agent 从持久化聊天历史、当前用户文字和消息附件构造上下文。图片附件以多模态内容发送给模型；当前不读取或修改桌面 Artifact。

## 当前 API

```
GET    /api/projects                      项目列表与桌面摘要
POST   /api/projects                      创建项目（含空桌面）
DELETE /api/projects/:id                  删除项目、Artifact 与本地文件
GET    /api/projects/:id/desk             桌面全量状态（artifacts + desk_state）
PATCH  /api/projects/:id/desk             保存桌面视口
PATCH  /api/projects/:id/desk/objects/:artifactId   移动/摆放物件
POST   /api/projects/:id/artifacts        创建 Artifact 首版本并可选摆放物件
POST   /api/projects/:id/files            上传资料（PDF/JPG/PNG）
GET    /api/files/:id                     读取上传或导出的文件
POST   /api/artifacts/:id/versions        追加版本（草稿/确认）
POST   /api/artifacts/:id/confirm         确认当前 Artifact
POST   /api/artifacts/:id/rollback        current_version 回滚（撤销）
WS     /api/projects/:id/chat             对话 + agent 事件流
                                        （text_delta→消息流；tool_execution_start/end→活动指示；
                                         object_changed→桌面增量更新）
POST   /api/projects/:id/export           导出提案包 PDF 与逐页 PNG
```

前端通过 `src/lib/api.ts` 连接 REST 与 WebSocket；DeskObject 模型由 Artifact 当前版本与 `desk_state.objects` 共同重建。

## 提案包导出

`ExportService`：取项目内 status=confirmed 的 Artifact + adopted 效果图，按叙事顺序（desk_state 物件空间序）填入 HTML 模板，playwright 打印 PDF + 逐页 PNG。产出存 FileStorage，登记 `proposal_package` Artifact（含导出时的版本快照指针，可复现）。

## 迁移与废弃

- `backend/`（Python）整体删除；alembic 迁移用 SQL 重述为 Drizzle migration
- CONTEXT.md 词条清理：删除"方案约束包/约束来源/约束强度/约束冲突/空间提案卡"，修订"提案画布/画布布局/效果图变体"以匹配桌面模型
- 旧 6 阶段 API 与 `ai_tasks` 表废弃，agent 会话取代表单式任务
