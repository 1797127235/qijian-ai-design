# Qijian AI Design

家装前期提案的 AI 设计工作台。当前第一条后端链路支持：创建项目、上传资料、创建可版本化的设计 Brief，以及读取 Brief 的当前版本和历史版本。

## 本地启动

需要 Node.js、Python 3.12+、Docker Compose 和 `uv`。

```bash
docker compose up -d postgres
cd backend
uv sync
uv run alembic upgrade head
uv run uvicorn app.main:app --reload --port 8001
```

另开一个终端运行 AI Worker：

```bash
cd backend
AI_API_KEY=your-key uv run python -m app.worker
```

另开一个终端运行前端：

```bash
npm install
npm run dev
```

浏览器打开 `http://localhost:5173`。Vite 将 `/api` 代理给本地 `http://localhost:8001`；接口文档位于 `http://localhost:8001/docs`。

## API 约定

- 开发环境使用预置的开发设计师身份，但每个项目都持久化 `owner_id`。
- `POST /api/v1/projects` 创建项目。
- `POST /api/v1/projects/{project_id}/files` 上传 PDF、JPG 或 PNG。
- `POST /api/v1/projects/{project_id}/artifacts` 创建 `design_brief` 的首个版本。
- `POST /api/v1/artifacts/{artifact_id}/versions` 追加新版本。
- `POST /api/v1/projects/{project_id}/project-understanding-tasks` 生成项目理解草稿。
- `POST /api/v1/projects/{project_id}/design-directions-tasks` 从确认的项目理解生成三张设计方向卡。
- `POST /api/v1/artifacts/{artifact_id}/design-direction-versions` 保存或确认设计方向集。

Artifact 内容不可覆盖。`artifacts` 保存稳定身份和当前版本指针，`artifact_versions` 保存完整的不可变历史。

项目理解生成使用 `AI_BASE_URL`、`AI_API_KEY` 与 `AI_MODEL` 环境变量；默认模型为 `grok-4.5-latest`。密钥只放在本地 `backend/.env` 或运行环境中，不能提交到仓库。

设计方向生成同样通过后台 Worker 执行。它只读取已确认的项目理解版本及其原始图纸、参考图引用；第一版输出结构化方向卡，不生成效果图。
