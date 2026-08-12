# 产品 Agent 内置 Skills 运行时

## 目标

给砌间桌面 Agent 按需加载**领域配方**，不打开 pi 的磁盘 skill 发现（`noSkills: true` 保持）。

## 布局

```
apps/server/src/agent/skills/     # 内置 skill 根（与 paths.ts 同级）
  paths.ts / catalog.ts           # 内容哈希 revision + 进程内 Registry Snapshot
  resolver.ts                     # $skill-id 确定性解析
  session-skill-state.ts          # loaded/emitted revision Ledger
  design-language/SKILL.md
  desk-loop/SKILL.md
data/design-library/              # 视觉语言数据（静态库，非 skill 工具）
```

根目录默认 `import.meta.url` 所在目录；可用 `SKILLS_DIR` 覆盖。

## 工具

| 工具 | 激活 | 作用 |
|------|------|------|
| `search_skills` | search_tools 打开 | L1 元数据与 revision |
| `load_skill` | search_tools 打开；wake 可读 | L2 正文与 baseDir（截断、emit once） |

- skill 正文**不**写入稳定身份 system 前缀
- skill **不**自动激活生图/删除
- wake 仍禁 `search_tools` 与 generate
- 用户显式写 `$skill-id` 时，Resolver 把正文放入当轮 Current Context Frame
- 同一 `id@revision` 在一个 trajectory 内只注入一次；状态随 session 持久化
- compaction 后保留 loaded revision、清空 emitted revision，并通过 `reload_required` 指示重载

## 内置 skill

| id | 用途 |
|----|------|
| `design-language` | 视觉语言如何进方向卡/生图（条目见 design-library） |
| `desk-loop` | 画布协作节奏与反模式 |

## 明确不做

- pi `noSkills: false` 扫 `~/.pi` / `.agents/skills`
- design-proposal Python/Web3D 整包
- 任意路径读盘、执行 skill scripts
