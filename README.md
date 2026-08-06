# Qijian AI Design

面向家装前期的**自由画布 AI 工作台**。前端 React/Vite，后端 Node、Hono、Drizzle/PostgreSQL，同进程嵌入 `@earendil-works/pi-coding-agent`。

产品方向见 [画布工作台设计](docs/canvas-workbench-design.md)：图放桌上 → 点选 → AI 出图落回 → 再改。不强制 Brief / 空间地图 / 阶段关卡。

## 当前能力

- 创建、查看和删除设计项目；每项目一张可平移、缩放、持久化布局的桌面。
- 右侧对话与附件；Agent 可分析对话与附件（业务桌面工具仍可为空，写路径边界保留）。
- Artifact 不可变版本历史；桌面位置、旋转、视口独立持久化。
- 已支持的 Artifact 类型：`understanding_note`、`design_directions`、`effect_image`。不兼容旧 `space_map` / Brief / `proposal_package` 数据。

已砍：空间地图、确认/采用审批、导出提案包、`/export` 与 confirm 流程关卡、`proposal_package` 类型壳。

## 本地启动

需要 Node.js 22.19+（pi SDK）、Docker Compose。

```bash
npm install
docker compose up -d postgres
npm run db:migrate
npm run dev:server
```

另开终端：

```bash
npm run dev
```

浏览器打开 `http://localhost:5173`。Vite 代理 REST/WebSocket 到 `http://localhost:8787`，健康检查 `http://localhost:8787/health`。

## 基本工作流

1. 新建项目，进入空桌面。  
2. 在对话里描述意图或丢附件；桌上可拖动物件（有内容时）。  
3. 与 Agent 连续迭代；不要求先完成某阶段。  

## Agent 配置

文本模型由 pi 的 `ModelRuntime` 读 `~/.pi/agent/models.json`。默认 `codex2api/grok-4.5-latest`，可用 `AGENT_PROVIDER` / `AGENT_MODEL` 覆盖。

图像生成（可选）通过进程环境注入，不会自动加载 `.env`：

```bash
export IMAGE_API_URL=https://example.com/v1/images/generations
export IMAGE_API_KEY=your-key
npm run dev:server
```

## 环境变量

| 变量 | 默认值 | 用途 |
|---|---|---|
| `DATABASE_URL` | `postgresql://qijian:qijian@localhost:5433/qijian` | PostgreSQL |
| `PORT` | `8787` | 后端端口 |
| `API_CORS_ORIGINS` | `http://localhost:5173` | CORS 来源 |
| `UPLOAD_DIR` | `data/uploads` | 上传目录 |
| `PUBLIC_BASE_URL` | `http://localhost:8787` | 文件 URL 基址 |
| `AGENT_PROVIDER` | `codex2api` | pi provider |
| `AGENT_MODEL` | `grok-4.5-latest` | 模型名 |
| `IMAGE_API_URL` | 空 | 图像生成端点 |
| `IMAGE_API_KEY` | 空 | 图像密钥 |

## 常用命令

```bash
npm run build          # 前端类型检查与构建
npm run build:server   # 后端类型检查
npm test               # 测试
npm run db:generate    # 生成迁移
npm run db:migrate     # 执行迁移
```

## 接口概览

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET / POST` | `/api/projects` | 列出或创建项目 |
| `DELETE` | `/api/projects/:id` | 删除项目与文件 |
| `GET` | `/api/projects/:id/desk` | 桌面与 Artifact 快照 |
| `PATCH` | `/api/projects/:id/desk` | 保存视口 |
| `PATCH` | `/api/projects/:id/desk/objects/:artifactId` | 移动/改尺寸旋转 |
| `POST` | `/api/projects/:id/artifacts` | 创建 Artifact（可带 layout） |
| `POST` | `/api/artifacts/:id/versions` | 追加版本 |
| `POST` | `/api/artifacts/:id/rollback` | 回滚版本指针 |
| `POST / GET` | `/api/projects/:id/files`、`/api/files/:id` | 上传/读文件 |
| `WS` | `/api/projects/:id/chat` | 对话与桌面变更 |

## 文档

- [画布工作台设计](docs/canvas-workbench-design.md)
- [领域词汇](CONTEXT.md)
- [设计系统](DESIGN.md)
- [架构决策记录](docs/adr/)（含历史流水线决策，以画布设计为准）
