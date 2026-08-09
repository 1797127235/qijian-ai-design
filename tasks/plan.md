# Implementation Plan: Agent `look_at`

## Overview

新增 Agent 工具 `look_at`：按 artifact id / alias 拉取最多 4 张 ready 原图，toolResult 内联像素，`role=inspect`，可做材质/细节判断。规格见 `docs/superpowers/specs/2026-08-09-agent-look-at-design.md`。

## Architecture Decisions

- 新文件 `look-at.ts`，镜像 `look-at-desk` 的 toolResult 附图路径 A，语义对齐 `planInspectSelection`。
- alias 解析用本轮 `compileDeskObjects` 的 A01…，不走对话模糊指代。
- 读图：`files.getById` + `files.read` → base64（与 loadAgentImages 图像路径一致，工具侧不强制走 PDF 分支）。
- 不改 session-registry 的自动 Inspect 前缀。

## Task List

### Phase 1: Tool core
- [ ] Task 1: `look-at.ts` + 单测（RED→GREEN）
- [ ] Task 2: 注册 + system prompt + UI label + 文档进度一句

### Checkpoint
- [ ] `npx vitest run apps/server/src/agent/tools/look-at` 绿
- [ ] `npm test` / `npm run build:server` 绿
- [ ] `look_at_desk` 测试无回归

## Risks

| Risk | Mitigation |
|------|------------|
| alias 与 Survey 编号不一致 | 同一 `compileDeskObjects` |
| 大图 base64 爆上下文 | 与选中 Inspect 同路径；全失败才 fail |

## Open Questions

无。
