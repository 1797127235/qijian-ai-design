# Agent 生图工具包拆分

> idea-refine 确认（2026-08-10）。意图相关：人机同桌闭环、`generate_from_desk` 旁落 vs 原卡替换。

## Problem Statement

How might we split the bloated single `generate_from_desk` into a maintainable generate toolkit so both humans and the agent know place-beside vs replace (and later text-to-image), without forking the write-desk pipeline?

## Recommended Direction

**E 骨架 + B 工具面：** 目录级工具包 + 两个 Agent 工具名。

1. `apps/server/src/agent/tools/generate/`
   - `shared/run-desk-generate.ts` — model 校验、ownedCurrent、jobs.run、prepare/complete
   - `from-source.ts` → `generate_from_desk`（旁落新卡，可参考）
   - `replace-on-source.ts` → `replace_on_desk`（原卡 append，无 `replace_in_place` 布尔）
   - `text-to-desk.ts` — **stub / 未注册**（无源文生，本轮不做）
   - `index.ts` — 导出 `createGenerateTools(ctx)`

2. 根 `tools/index.ts` 改为 `...createGenerateTools(ctx)` + look_at / get_task。

3. **system-prompt / JOB_EVENT 文案** 改为两个工具名；失败禁止盲刷时写清「勿自动再调同一工具」。

4. **Job kind：** MVP 继续一种 kind（如仍叫 `generate_from_desk`）+ input 字段区分旁落/替换；观测不够时再分 kind。

5. **ADR：** 修订 0013 或补短 ADR：写桌可多工具名，共用一条生成管线。

### 谁受益 / 成功 / 约束

| 项 | 决策 |
|----|------|
| 受益 | 人维护代码 + Agent 少选错 |
| 成功 | 代码更好改（加文生图/局部时不必再塞一个大文件） |
| 约束 | 可以慢一点做对 |

## Key Assumptions to Validate

- [ ] 拆成 2 名后，模型在 dogfood「重新生成」时更常调 `replace_on_desk`（对照日志）
- [ ] 共享 `run-desk-generate` 后，加文生图不必改 Job 外壳
- [ ] 单 kind 足够 wake/观测；若不够再分 kind

## MVP Scope

**In**

- 抽出 shared runner
- 注册 `generate_from_desk` + `replace_on_desk`
- 去掉合并工具上的 `replace_in_place`
- 更新 system-prompt + 测试迁移
- 行为与现在一致：旁落 / 原卡替换都能绿测

**Out**

- 文生图实现
- Agent 局部重绘
- 改面板 HTTP 多 endpoint
- pi skill 包 / 多 agent

## Not Doing (and Why)

- 三工具一次上齐（含文生）— 成功标准是可维护，不是功能清单
- 按 edits vs generations 拆工具 — 落点语义比上游路径更贴产品
- 大改 CanvasGenerateService — 只扩调用方，不拆服务

## Open Questions

- Job kind 单 vs 双：MVP 单 kind 是否接受？（方案默认：单 kind）
- 旧对话里模型仍可能 hallucinate `replace_in_place`：是否在 system 写「已废弃」一行？
- 是否现在就写 ADR，还是合入 PR 时再写？

## 建议落地顺序

1. 抽 `run-desk-generate` + 单测迁到 `generate/`
2. 拆两个 tool 定义，注册进 `createDeskTools`
3. 改 system-prompt / session-registry 测试
4. dogfood：旁落一句、原卡替换一句
5. ADR 补记 + 文生图 stub 注释预留

## 实现状态（2026-08-10）

- [x] `tools/generate/shared/run-desk-generate.ts`
- [x] `generate_from_desk` + `replace_on_desk` 注册
- [x] 移除根目录单体 `generate-from-desk.ts` 与 `replace_in_place` 布尔
- [x] system-prompt / ADR 0013 / JOB_EVENT 文案
- [x] 测试迁移
- [ ] dogfood 验证（并发帽 / 旁落不叠卡 / replace 默认语义）
- [x] 文生图实现：`text_to_image_on_desk` + spawn 空位落点（2026-08-10）
- [x] 并发：lock=新卡 + `maxActive` 串行 create + wake 批合并（2026-08-10）
- [x] `remove_from_desk`（同会话后续切片）
