# Qijian AI Design

面向家装前期提案的单画布 AI 设计桌面。前端是 React/Vite，后端使用 Node、Hono、Drizzle/PostgreSQL，并在同一进程嵌入 `@earendil-works/pi-coding-agent`。

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

浏览器打开 `http://localhost:5173`。Vite 会把 REST 与 WebSocket 请求代理到 `http://localhost:8787`。

## Agent 配置

文本模型由 pi 的 `ModelRuntime` 读取 `~/.pi/agent/models.json` 和对应凭据。可在 `models.json` 中配置 Grok 等 OpenAI 兼容 provider；后端不读取或保存文本模型密钥。默认选择 `codex2api/grok-4.5-latest`，可通过 `AGENT_PROVIDER` 和 `AGENT_MODEL` 覆盖。

图像生成是独立边界，通过以下环境变量配置：

```bash
IMAGE_API_URL=https://example.com/v1/images/generations
IMAGE_API_KEY=your-key
```

提案导出默认使用 Playwright Chromium（首次安装运行 `npx playwright install chromium`）；也可通过 `PLAYWRIGHT_CHROMIUM_PATH` 指定非 Snap 版系统 Chromium。

## 常用命令

```bash
npm run build          # 前端类型检查与生产构建
npm run build:server   # 后端严格类型检查与编译
npm test               # 服务层测试
npm run db:generate    # 根据 Drizzle schema 生成迁移
npm run db:migrate     # 执行迁移
```

Artifact 内容不可覆盖。`artifacts` 保存稳定身份和当前版本指针，`artifact_versions` 保存不可变历史；物件位置、旋转和视口独立保存在 `desk_state`。
