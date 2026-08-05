# Qijian AI Design

面向家装前期提案的单画布 AI 设计桌面。前端是 React/Vite，后端使用 Node、Hono、Drizzle/PostgreSQL，并在同一进程嵌入 `@earendil-works/pi-coding-agent`。

## 当前能力

- 创建、查看和删除设计项目；每个项目对应一张可平移、缩放和持久化布局的设计桌面。
- 录入并确认设计 Brief，上传 PDF、JPG 或 PNG 户型资料，在图纸上框选并标记关键空间。
- 通过对话让 Agent 读取桌面、生成理解便签、创建三个可比较的设计方向、生成效果图变体并整理桌面。
- 在 `每步请示` 与 `完全放手` 两种项目级权限之间切换；请示模式下，Agent 写操作需要在对话栏批准。
- 采用或弃用效果图变体，将已确认 Artifact 和已采用效果图导出为 PDF 及逐页 PNG。
- 对 Artifact 内容保留不可变版本历史；桌面位置、旋转和视口独立持久化。

## 本地启动

需要 Node.js 22.19+（pi SDK 的运行时要求）、Docker Compose，以及 Chromium（用于导出提案包）。

```bash
npm install
docker compose up -d postgres
npm run db:migrate
npm run dev:server
```

另开一个终端：

```bash
npm run dev
```

浏览器打开 `http://localhost:5173`。Vite 会把 REST 与 WebSocket 请求代理到 `http://localhost:8787`，服务健康检查位于 `http://localhost:8787/health`。

首次导出提案包前如未安装 Playwright 浏览器，运行：

```bash
npx playwright install chromium
```

## 基本工作流

1. 在项目列表新建设计桌面。
2. 填写 Brief，上传户型图纸，在图纸上拖出空间区域并至少标记一个关键空间。
3. 确认 Brief 和空间地图后，在右侧对话栏要求 Agent 整理项目理解或创建三个设计方向。
4. 比较并确认一个方向，再要求 Agent 为指定空间生成效果图；对候选图执行采用或弃用。
5. 点击顶部“导出提案包”，导出当前已确认内容和已采用效果图。

## Agent 配置

文本模型由 pi 的 `ModelRuntime` 读取 `~/.pi/agent/models.json` 和对应凭据。可在 `models.json` 中配置 Grok 等 OpenAI 兼容 provider；后端不读取或保存文本模型密钥。默认选择 `codex2api/grok-4.5-latest`，可通过 `AGENT_PROVIDER` 和 `AGENT_MODEL` 覆盖。

图像生成是独立边界，通过以下环境变量配置。服务端直接读取进程环境，不会自动加载 `.env`；需要在启动服务前导出变量，或由进程管理器注入：

```bash
export IMAGE_API_URL=https://example.com/v1/images/generations
export IMAGE_API_KEY=your-key
npm run dev:server
```

提案导出默认使用 Playwright Chromium；也可通过 `PLAYWRIGHT_CHROMIUM_PATH` 指定系统 Chromium。

## 环境变量

| 变量 | 默认值 | 用途 |
|---|---|---|
| `DATABASE_URL` | `postgresql://qijian:qijian@localhost:5433/qijian` | PostgreSQL 连接地址 |
| `PORT` | `8787` | 后端监听端口 |
| `API_CORS_ORIGINS` | `http://localhost:5173` | 允许的前端来源，多个值用逗号分隔 |
| `UPLOAD_DIR` | `data/uploads` | 上传文件和导出文件目录 |
| `PUBLIC_BASE_URL` | `http://localhost:8787` | 文件公开 URL 的服务端基址 |
| `AGENT_PROVIDER` | `codex2api` | pi 模型 provider |
| `AGENT_MODEL` | `grok-4.5-latest` | pi 模型名称 |
| `IMAGE_API_URL` | 空 | OpenAI 风格图像生成端点 |
| `IMAGE_API_KEY` | 空 | 图像生成服务密钥 |
| `PLAYWRIGHT_CHROMIUM_PATH` | 空 | 可选的 Chromium 可执行文件路径 |

## 常用命令

```bash
npm run build          # 前端类型检查与生产构建
npm run build:server   # 后端严格类型检查与编译
npm test               # 服务层测试
npm run db:generate    # 根据 Drizzle schema 生成迁移
npm run db:migrate     # 执行迁移
npm run preview        # 预览前端生产构建
```

## 接口概览

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET / POST` | `/api/projects` | 列出或创建项目 |
| `DELETE` | `/api/projects/:id` | 删除项目及其上传文件 |
| `GET` | `/api/projects/:id/desk` | 读取 Artifact 当前版本和桌面状态 |
| `PATCH` | `/api/projects/:id/desk` | 保存视口 |
| `PATCH` | `/api/projects/:id/desk/objects/:artifactId` | 移动物件或修改其桌面尺寸、旋转 |
| `POST` | `/api/projects/:id/artifacts` | 创建 Artifact 首版本并可选摆放到桌面 |
| `POST` | `/api/artifacts/:id/versions` | 追加不可变版本 |
| `POST` | `/api/artifacts/:id/confirm` | 确认当前 Artifact |
| `POST` | `/api/artifacts/:id/rollback` | 将当前版本指针回滚到指定或上一版本 |
| `POST / GET` | `/api/projects/:id/files`、`/api/files/:id` | 上传或读取项目文件 |
| `GET / PUT` | `/api/projects/:id/permission` | 读取或切换 Agent 权限模式 |
| `POST` | `/api/projects/:id/export` | 导出 PDF 和逐页 PNG，并登记提案包 Artifact |
| `WS` | `/api/projects/:id/chat` | 对话、Agent 事件、审批和桌面变更通知 |

支持的 Artifact 类型为 `design_brief`、`space_map`、`understanding_note`、`design_directions`、`effect_image` 和 `proposal_package`。Artifact 内容不可覆盖：`artifacts` 保存稳定身份和当前版本指针，`artifact_versions` 保存不可变历史；物件位置、旋转和视口独立保存在 `desk_state`。

## 文档导航

- [领域词汇](CONTEXT.md)
- [设计系统](DESIGN.md)
- [Agent 后端重写与当前架构](docs/implementation/agent-backend-redesign.md)
- [架构决策记录](docs/adr/)
- [产品探索记录（历史）](docs/product-discovery-grill.md)
