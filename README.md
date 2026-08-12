# Qijian AI Design

面向家装前期的**自由画布 AI 工作台**。前端 React/Vite，后端 Node、Hono、Drizzle/PostgreSQL，同进程嵌入 `@earendil-works/pi-coding-agent`。

产品方向：图放桌上 → 点选 → AI 出图落回 → 再改。不强制 Brief / 空间地图 / 阶段关卡。

> 说明：仓库根目录若无 `docs/canvas-workbench-design.md`，以 `CONTEXT.md`、`docs/canvas-connections-generate-design.md` 与 `docs/adr/` 为准。

## 当前能力

- 创建、查看、改名和删除设计项目；每项目一张可平移、缩放、持久化布局的桌面。
- 右侧多线程对话与附件；过程时间线展示 Agent 思考与工具调用。
- 画布：中键/空格漫游、框选多选、物件连线（参考关系）、选中下方 Prompt 面板生图、会话内撤销/重做。
- Agent 可分析桌面与选中，经 `generate_from_desk`（旁落）/ `replace_on_desk`（原卡）/ `text_to_image_on_desk`（无主源文生）异步 Job 写回 `effect_image`（ADR 0013）；可 `remove_from_desk` 删卡；按需 `look_at_desk` / `look_at`。
- 局部重绘（框选区域 + prompt / 参考图）、大图查看、左下角 minimap 导航。
- Artifact 不可变版本历史；桌面位置、旋转、视口与 `connections` 独立持久化。
- 已支持的 Artifact 类型：`canvas_image`、`effect_image`。

已砍：空间地图、确认/采用审批、导出提案包、`/export` 与 confirm 流程关卡、`proposal_package` 类型壳、`sticky_note`。

## 本地启动

需要 Node.js 22.19+（pi SDK）、Docker Compose。

```bash
npm install
docker compose up -d postgres redis
npm run db:migrate
npm run dev:server
```

另开终端：

```bash
npm run dev
```

浏览器打开 `http://localhost:5173`。Vite 代理 REST/WebSocket 到 `http://localhost:8787`，健康检查 `http://localhost:8787/health`。

开发时可将 `.env` 放在仓库根目录；**图像相关变量需由启动进程注入**（`npm run dev:server` 若未加载 dotenv，请用 `export` 或你的进程管理器带上环境变量）。

## 基本工作流

1. 新建项目，进入空桌面。  
2. 上传/放置图片，或拖把手连线指定参考。  
3. 点选物件 → 下方提示词面板生图，或在右侧与 Agent 连续迭代。  
4. 需要时用局部重绘改局部；minimap 快速平移。

## Agent 配置

文本模型由 pi 的 `ModelRuntime` 读 `~/.pi/agent/models.json`。默认 `codex2api/grok-4.5-latest`，可用 `AGENT_PROVIDER` / `AGENT_MODEL` 覆盖。

图像生成（可选，支持多网关）：

```bash
# 主站（例如 Grok / codex2api）
export IMAGE_API_URL=https://example.com/v1/images/generations
export IMAGE_API_KEY=your-key
export IMAGE_MODEL=grok-imagine-image-quality
export IMAGE_PROVIDER_LABEL=Grok

# 附加网关（面板选 model 时自动路由到对应 URL/Key）
# export IMAGE_PROVIDER_2_URL=http://openai2api.com:3000/v1
# export IMAGE_PROVIDER_2_KEY=your-key-2
# export IMAGE_PROVIDER_2_MODELS=gpt-image-2
# export IMAGE_PROVIDER_2_LABEL=OpenAI2API

# 可选：结果图 URL 下载代理（x.ai 等图床）；生成 API 本身默认直连
# export IMAGE_FETCH_PROXY=http://127.0.0.1:7897
npm run dev:server
```

约定：

- **model id 全局唯一**；跨网关重复时先注册的网关生效，启动会 `console.warn`。
- 面板选定 model 后，文生图与 edits 使用同一 model id。
- **Agent** 生图工具可传 `model`（与面板同一 allowlist）；省略则主站默认。未知 model 失败，禁止静默回落。
- 同项目图像任务 active 默认 **4**（`TASK_PROJECT_IMAGE_CONCURRENCY`）：超出 **排队**（BullMQ），不是工具直接失败。需另开 `npm run dev:worker`。

工具白名单：`generate_from_desk`、`replace_on_desk`、`text_to_image_on_desk`、`remove_from_desk`、`get_task`、`look_at_desk`、`look_at`（`AGENT_DEBUG_IMAGE_TOOL=1` 时另有调试图工具）。实现：`apps/server/src/agent/tools/generate/` + `remove-from-desk.ts`；执行：`apps/server/src/tasks/` + Worker。

## 环境变量

| 变量 | 默认值 | 用途 |
|---|---|---|
| `DATABASE_URL` | `postgresql://qijian:qijian@localhost:5433/qijian` | PostgreSQL |
| `PORT` | `8787` | 后端端口 |
| `API_CORS_ORIGINS` | `http://localhost:5173` | CORS 来源 |
| `UPLOAD_DIR` | `data/uploads` | 上传目录 |
| `PUBLIC_BASE_URL` | `http://localhost:8787` | 文件 URL 基址 |
| `AGENT_PROVIDER` | `codex2api` | pi provider |
| `AGENT_MODEL` | `grok-4.5-latest` | 对话模型名 |
| `IMAGE_API_URL` | 空 | **主**生图网关（`/images/generations`） |
| `IMAGE_API_KEY` | 空 | 主网关密钥 |
| `IMAGE_MODEL` | `grok-imagine-image-quality` | 主站默认 model |
| `IMAGE_EDIT_MODEL` | 同 `IMAGE_MODEL` | 主站 edits 默认 model |
| `IMAGE_MODEL_OPTIONS` | 内置 grok 集 | 主站模型列表（逗号分隔） |
| `IMAGE_PROVIDER_2_URL`…`_5` | 空 | 附加网关 base 或 generations URL |
| `IMAGE_PROVIDER_2_KEY`… | 空 | 附加网关密钥 |
| `IMAGE_PROVIDER_2_MODELS`… | 空 | 该网关模型列表（逗号分隔） |
| `IMAGE_PROVIDER_2_LABEL`… | provider id | 面板展示名 |
| `IMAGE_SIZE` | 空 | 默认尺寸偏好（`1:1` / `WxH`）；空=不传 |
| `IMAGE_FETCH_PROXY` | 空（或 `HTTPS_PROXY`） | 结果图下载代理 |
| `TEXT_API_URL` | 由 `IMAGE_API_URL` 推导 chat | 起名 / caption 等 |
| `TEXT_API_KEY` | 回退 `IMAGE_API_KEY` | 文本密钥 |
| `TEXT_MODEL` | 回退 `AGENT_MODEL` | 文本模型 |
| `LANGSMITH_TRACING` | `false` | Agent 观测（H7）；root 带 `model_usage` 汇总 |
| `LANGSMITH_API_KEY` | 空 | LangSmith |
| `LANGSMITH_PROJECT` | `pi` | LangSmith 项目名 |
| `LANGSMITH_ENDPOINT` | LangSmith 云 | 端点 |
| `AGENT_LOG_USAGE` | 关 | `1` 时每 model turn 打 `model_usage` JSON（含 cache hit） |
| `REDIS_URL` | `redis://localhost:6379` | BullMQ 调度（业务态在 PG） |
| `TASK_QUEUE_PREFIX` | `qijian` | BullMQ key 前缀 |
| `TASK_WORKER_CONCURRENCY` | `4` | Worker 全局并发（含生图与命名） |
| `WORKER_METRICS_PORT` | `9465` | Worker readiness / Prometheus 端口 |
| `TASK_PROJECT_IMAGE_CONCURRENCY` | `4` | 同项目图像任务 active 上限（排队而非直接失败） |
| `TASK_IMAGE_MAX_ATTEMPTS` | `3` | 生图自动重试含首次上限（明确白跑才重试） |
| `TASK_IMAGE_BACKOFF_MS` | `2000` | 生图重试退避基数 ms（×2，封顶 60s） |
| `BULL_BOARD_PATH` | `/admin/queues` | 队列管理页路径 |
| `BULL_BOARD_USERNAME` / `PASSWORD` | 空 | 生产务必配置；未配则强制只读 |
| `BULL_BOARD_READ_ONLY` | `true` | 无写操作；有凭据后可改 `false` |

生图/起名后台任务走 **BullMQ + 独立 Worker**（`npm run dev:worker`）。无 legacy 进程内 runner。

## 常用命令

```bash
npm run build          # 前端类型检查与构建
npm run build:server   # 后端类型检查
npm run dev:server     # API（含 outbox dispatcher）
npm run dev:worker     # BullMQ Worker（生图 + 起名）
npm test               # 测试
npm run db:generate    # 生成迁移
npm run db:migrate     # 执行迁移
```

## 运行监测

API 在 `/health`、`/ready`、`/metrics` 分别提供存活、依赖就绪和 Prometheus 指标；Worker 在 9465 端口提供同类接口。启动本地监测后台：

```bash
docker compose --profile monitoring up -d
```

Grafana 运行看板位于 `http://localhost:3001/d/qijian-runtime`，Prometheus 和 Alertmanager 分别位于 9090、9093。指标口径、告警阈值、关联追踪和故障演练见 [Agent 运行监测手册](docs/runbooks/observability.md)。

## 接口概览

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET / POST` | `/api/projects` | 列出或创建项目 |
| `PATCH` | `/api/projects/:id` | 项目改名等 |
| `DELETE` | `/api/projects/:id` | 删除项目与文件 |
| `GET` | `/api/projects/:id/desk` | 桌面与 Artifact 快照（含 connections） |
| `PATCH` | `/api/projects/:id/desk` | 保存视口 |
| `PATCH` | `/api/projects/:id/desk/objects/:artifactId` | 移动/改尺寸旋转 |
| `POST` | `/api/projects/:id/desk/connections` | 新建连线 |
| `DELETE` | `/api/projects/:id/desk/connections/:connectionId` | 删除连线 |
| `POST` | `/api/projects/:id/generate-image` | 面板/重试/局部重绘生图（异步 Job） |
| `POST` | `/api/projects/:id/artifacts` | 创建 Artifact（可带 layout） |
| `POST` | `/api/artifacts/:id/versions` | 追加版本 |
| `POST` | `/api/artifacts/:id/rollback` | 回滚版本指针 |
| `POST / GET` | `/api/projects/:id/files`、`/api/files/:id` | 上传/读文件 |
| `WS` | `/api/projects/:id/chat` | 对话、过程事件与桌面变更 |
| `GET` | `/api/public-config` | 公开配置（生图模型列表等，无密钥） |
| `GET` | `/admin/queues` | Bull Board（默认只读；生产配 Basic Auth） |

## 文档

- [领域词汇](CONTEXT.md)
- [设计系统](DESIGN.md)
- [待办](TODOS.md)
- [资产任务队列运维](docs/runbooks/asset-task-queue.md)
- [Agent 运行监测与告警](docs/runbooks/observability.md)
- [ADR 0014 BullMQ](docs/adr/0014-bullmq-task-queue-for-asset-batches.md)
- [画布连线 + 面板生图](docs/canvas-connections-generate-design.md)
- [局部重绘](docs/canvas-inpainting-design.md)
- [Agent 上下文管理当前实现](docs/agent-context-management.md)
- [Agent 桌面上下文装配](docs/agent-desk-context-assembly.md)
- [架构决策记录](docs/adr/)（含历史流水线决策，以画布现状为准）
