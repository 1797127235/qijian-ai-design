# Spec: Agent `look_at` — 按需单/多物件细看（L3）

## Objective

给 Agent 增加按需工具 **`look_at`**：在用户未选中、或需要细看非本轮选中物件时，按 artifact id / alias 拉取最多 4 张 ready 原图，以 toolResult 内联像素返回，**算 [INSPECT]**，可据此做材质/比例/细节判断。

**用户：** 桌面设计助手（Agent）  
**成功：** 未选中时也能主动细看指定物件；与选中自动 Inspect、`look_at_desk` 边界清晰。

## Assumptions（请确认）

1. 工具名 **`look_at`**（文档历史名），参数 **`ids`**：`string[]`，每项为 artifact UUID **或** 本轮桌面 alias（`A01`…，大小写不敏感）。
2. **最多 4 张**真图进结果（对齐 `MAX_INSPECT_IMAGES`）；超出部分文本声明 `over_budget`，不整工具失败。
3. 返回 **算 [INSPECT]**：`details.role = "inspect"`；文本块声明已附原图的 id；模型可对列入 id 做像素级断言。
4. **不改本轮 prompt 前缀**的 `[INSPECT]` 块（那是选中自动路径）；本工具结果独立出现在 toolResult 中，system prompt 明确：tool 成功返回的 inspect 图与选中 Inspect **同权**。
5. 仅 `lifecycle=ready` 且有 `file_id` 的 `canvas_image` / `effect_image`；pending/empty/failed/missing/off_desk/not_image → 进 skipped 文本，有至少 1 张成功则工具 ok。
6. **全部失败**（0 张真图）→ 整工具 fail。
7. alias 按**当前桌面 snapshot** 的 `compileDeskObjects` 编号解析；解析不到 → skipped `missing`；不支持「模糊 label 唯一消解」进工具参数（那是对话指代路径）。
8. 与 `look_at_desk` 并存：总览仍不算 Inspect；细看用 `look_at`。
9. 读图复用 `files.loadAgentImages`（或等价 getById+read+base64）；单次 base64 总预算对齐现有 agent 限额，超限 fail 或截断并声明（实现选更严的 fail-with-reason）。
10. 前端过程面板为 `look_at` 增加中文 label「细看物件」。

## Tech Stack

- 现有：`apps/server` Hono + pi-coding-agent tools、`desk-context` Inspect 规划、`FileStorage.loadAgentImages`
- 无新依赖

## Commands

```bash
npm test
npm run build:server
# 可选聚焦
npx vitest run apps/server/src/agent/tools/look-at
```

## Project Structure

```
apps/server/src/agent/tools/look-at.ts          # 新工具
apps/server/src/agent/tools/look-at.test.ts
apps/server/src/agent/tools/index.ts            # 注册
apps/server/src/agent/system-prompt.ts          # 指引
apps/server/src/agent/session-factory.ts        # 注释白名单
src/desk/chat/process-summary.ts               # UI label
docs/agent-desk-*.md                           # 进度一句更新
docs/superpowers/specs/2026-08-09-agent-look-at-design.md  # 本文
```

## Code Style

对齐 `look-at-desk.ts` / `generate-from-desk.ts`：

- `defineTool` + TypeBox parameters
- `fail` / 成功 `{ content: [text, ...images], details }`
- 文件头中文职责注释；无多余注释

## Behavior

### 参数

| 字段 | 类型 | 约束 |
|------|------|------|
| `ids` | `string[]` | minItems 1，maxItems 4（参数层）；每项非空 trim |

> 若模型传 >4：参数校验失败或 execute 内截断前 4 并文本说明——**实现取 Type maxItems=4 硬拒**，与 generate 的 max 风格一致。

### 解析顺序（每个 token）

1. trim；空跳过  
2. 若匹配 `^A\d{2,}$`（i）→ 在本轮 objects 中找 `alias`  
3. 否则当 artifact id 在 objects / artifacts 中查找  
4. 同一 artifact 去重（先出现优先）

### 纳入 / 跳过

复用或镜像 `planInspectSelection` 规则：`ready`+file → included；否则 skipped 原因同现有枚举。

### 成功 toolResult

**text（示例结构）：**

```
[INSPECT] look_at 工具结果（下列 id 已附原图像素，可做材质/比例/细节判断）：
- image_1 = A03 <uuid> 「客厅原图」 file=<file_id>
- 未附原图：A05 生成中；xyz 不存在
```

**images：** 与 text 中 image_N 顺序一致，mime 来自存储。

**details：**

```json
{
  "ok": true,
  "role": "inspect",
  "included_ids": ["..."],
  "skipped": [{ "id": "...", "reason": "pending" }],
  "image_count": 1
}
```

### 失败

- `ids` 空 / 全无效且 0 张图 → `fail`，reason 如 `no_inspect_pixels`
- 读盘异常 → 对应 id skipped 或整工具 fail（实现：单张失败记 empty，全失败 fail）

### System prompt 增补（要点）

- 未选中或需细看非选中物件时调用 `look_at`（传 artifact id 或 A0x）。
- `look_at` 成功返回的图 **算 [INSPECT]**；`look_at_desk` 仍不算。
- 工具参数可用 alias；写桌工具仍优先 UUID（保持 generate 约束，look_at 额外允许 alias）。

### 白名单

`generate_from_desk` | `get_task` | `look_at_desk` | **`look_at`**

## Testing Strategy

| 用例 | 期望 |
|------|------|
| ready 单 id | 1 图 + role inspect |
| alias `A01` | 解析并附图 |
| 混合 id+alias，4 上限 | 第 5 不进参数或硬拒 |
| pending only | fail no pixels |
| 1 ready + 1 pending | ok，skipped 含 pending |
| 重复 id | 去重 1 张 |
| 错误 project / 不存在 | skipped / fail |
| 注册表含 `look_at` | tools index / session 测试若有白名单断言则更新 |

框架：vitest，风格同 `look-at-desk.test.ts`。

## Boundaries

- **Always：** 单测绿；更新 system prompt + 过程面板 label；不把 overview 标成 inspect  
- **Ask first：** 改 `MAX_INSPECT_IMAGES` 全局默认；跨轮「记住已 look_at」状态机  
- **Never：** 用 look_at 写桌；把 desk_overview 算 inspect；静默吞全部读盘失败当成功  

## Success Criteria

1. Agent 工具列表含 `look_at`；未选中时可对 A0x/id 拉到原图。  
2. 成功结果 `details.role === "inspect"`，文本明确可像素判断。  
3. 最多 4；alias 解析与 Survey 编号一致。  
4. `look_at_desk` 行为与测试零回归。  
5. `npm test` 与 `npm run build:server` 通过。  

## Open Questions

- 无（选型已确认：新工具、max 4 + alias、算 Inspect）。  
- 实现阶段若 base64 单图过大：是否缩略——**默认不缩略**（与选中 Inspect 一致）；若选中路径已缩再对齐。

## Out of Scope

- Compare 模式、几何「左边」、每轮默认塞图  
- 跨轮 inspect 缓存 / 会话级 inspect 集合  
- 前端画布 UI 按钮「让 AI 看这张」（仅 Agent 工具）  
