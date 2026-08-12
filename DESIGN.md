---
version: beta
name: Qijian-Paper-Atelier
description: 砌间 AI Design 的设计系统 ——「纸面工作室」。为家装设计师打造的 AI 提案工作台，界面气质是建筑事务所的提案册：暖纸面画布、衬线标题、单一陶土强调色、hairline 分层。Chrome 退后，让 AI 生成的空间图像成为界面中唯一的色彩来源。工作台区（列表/画布/约束包）网格纪律、中高密度；阅读区（项目理解/方向卡/提案包）编辑排版、叙事节奏。

colors:
  canvas: "#faf9f5"
  surface: "#f3f0e9"
  surface-card: "#ffffff"
  ink: "#1c1a16"
  ink-soft: "#3d3a33"
  mute: "#6e6a61"
  mute-soft: "#9b968a"
  hairline: "#e3ded4"
  hairline-strong: "#d4cec0"
  accent: "#b5532a"
  accent-hover: "#9a4623"
  accent-soft: "#f5e8e0"
  on-accent: "#ffffff"
  success: "#4a7a5c"
  warning: "#b98a2e"
  error: "#b0443c"
  info: "#587a8a"
  dark-canvas: "#1c1a16"
  dark-surface: "#24211c"
  dark-surface-card: "#2a2721"
  dark-ink: "#f0ede6"
  dark-ink-soft: "#d8d4ca"
  dark-mute: "#a39e92"
  dark-mute-soft: "#6e6a61"
  dark-hairline: "#3a362e"
  dark-hairline-strong: "#4a453a"
  dark-accent: "#d0693f"
  dark-accent-soft: "#3d2a20"

typography:
  display-xl:
    fontFamily: Fraunces, "Noto Serif SC", serif
    fontSize: 52px
    fontWeight: 500
    lineHeight: 1.12
    letterSpacing: -0.02em
  display-lg:
    fontFamily: Fraunces, "Noto Serif SC", serif
    fontSize: 36px
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: -0.01em
  display-md:
    fontFamily: Fraunces, "Noto Serif SC", serif
    fontSize: 28px
    fontWeight: 500
    lineHeight: 1.25
    letterSpacing: -0.01em
  display-sm:
    fontFamily: Fraunces, "Noto Serif SC", serif
    fontSize: 22px
    fontWeight: 500
    lineHeight: 1.3
  display-xs:
    fontFamily: Fraunces, "Noto Serif SC", serif
    fontSize: 18px
    fontWeight: 500
    lineHeight: 1.35
  body-lg:
    fontFamily: "Instrument Sans", "Noto Sans SC", sans-serif
    fontSize: 17px
    fontWeight: 400
    lineHeight: 1.65
  body-md:
    fontFamily: "Instrument Sans", "Noto Sans SC", sans-serif
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.65
  body-md-strong:
    fontFamily: "Instrument Sans", "Noto Sans SC", sans-serif
    fontSize: 15px
    fontWeight: 500
    lineHeight: 1.65
  body-sm:
    fontFamily: "Instrument Sans", "Noto Sans SC", sans-serif
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.6
  body-sm-strong:
    fontFamily: "Instrument Sans", "Noto Sans SC", sans-serif
    fontSize: 13px
    fontWeight: 500
    lineHeight: 1.6
  meta-mono:
    fontFamily: "JetBrains Mono", monospace
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
  eyebrow-mono:
    fontFamily: "JetBrains Mono", monospace
    fontSize: 11px
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: 0.12em
  button-md:
    fontFamily: "Instrument Sans", "Noto Sans SC", sans-serif
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.4

rounded:
  xs: 2px
  sm: 4px
  md: 6px
  lg: 8px
  full: 9999px

spacing:
  xxs: 2px
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 20px
  2xl: 24px
  3xl: 32px
  4xl: 48px
  5xl: 64px

components:
  app-topbar:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-sm-strong}"
    borderBottom: "1px solid {colors.hairline}"
    padding: "{spacing.md} {spacing.xl}"
  sidebar:
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.hairline}"
    padding: "{spacing.lg}"
  sidebar-item:
    typography: "{typography.body-sm}"
    rounded: "{rounded.sm}"
    padding: "{spacing.sm} {spacing.md}"
  sidebar-item-active:
    backgroundColor: "{colors.surface-card}"
    borderColor: "{colors.hairline}"
    typography: "{typography.body-sm-strong}"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.button-md}"
    rounded: "{rounded.sm}"
    padding: "10px 18px"
  button-secondary:
    backgroundColor: "{colors.surface-card}"
    textColor: "{colors.ink}"
    borderColor: "{colors.hairline-strong}"
    typography: "{typography.button-md}"
    rounded: "{rounded.sm}"
    padding: "10px 18px"
  button-ghost:
    backgroundColor: transparent
    textColor: "{colors.mute}"
    typography: "{typography.button-md}"
    padding: "10px 18px"
  text-input:
    backgroundColor: "{colors.surface-card}"
    textColor: "{colors.ink}"
    borderColor: "{colors.hairline-strong}"
    typography: "{typography.body-md}"
    rounded: "{rounded.sm}"
    padding: "10px 14px"
  card:
    backgroundColor: "{colors.surface-card}"
    borderColor: "{colors.hairline}"
    rounded: "{rounded.md}"
    padding: "{spacing.2xl}"
  direction-card:
    backgroundColor: "{colors.surface-card}"
    borderColor: "{colors.hairline}"
    rounded: "{rounded.md}"
    titleTypography: "{typography.display-xs}"
    metaTypography: "{typography.body-sm}"
  badge-source:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.mute}"
    borderColor: "{colors.hairline}"
    typography: "{typography.eyebrow-mono}"
    rounded: "{rounded.xs}"
    padding: "3px 8px"
  badge-hard:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
    typography: "{typography.eyebrow-mono}"
    rounded: "{rounded.xs}"
    padding: "3px 8px"
  confirmation-seal:
    textColor: "{colors.accent}"
    borderColor: "{colors.accent}"
    borderWidth: 1.5px
    typography: "{typography.meta-mono}"
    rounded: "{rounded.sm}"
    padding: "6px 12px"
    transform: "rotate(-2deg)"
  reading-sheet:
    backgroundColor: "{colors.surface-card}"
    borderColor: "{colors.hairline}"
    rounded: "{rounded.lg}"
    padding: "{spacing.5xl} {spacing.4xl}"
    maxWidth: 640px
---

# Design System — 砌间 Qijian AI Design

## Product Context
- **What this is:** AI 驱动的家装前期提案工作台。设计师从户型图和对话开始，完成项目理解、设计方向集、方案约束包、提案画布与客户提案包。
- **Who it's for:** 家装设计师（专业、每天使用、对视觉品质敏感）。
- **Space/industry:** 家装设计工具（ peers：酷家乐、Figma、Motiff、住小帮 ）。
- **Project type:** 高密度 web 工作台 + 编辑式阅读视图。

**记忆点（memorable thing）：** 安静优雅的编辑感。用户第一次打开应觉得「这像一本建筑事务所的提案册」，所有设计决策为此服务。

## Aesthetic Direction
- **Direction:** Editorial / 纸面工作室（Paper Atelier）
- **Decoration level:** intentional — 只用 hairline 与留白分层，不堆阴影，无装饰渐变，无图标插画堆砌
- **Mood:** 安静、克制、有纸质温度；专业但不冷峻
- **Reference:** getdesign.md 目录调研（Claude 的暖纸面+衬线、Notion 的纸感、Linear 的克制密度）；刻意偏离 Figma/酷家乐的深色工具风

## Typography
- **Display/Hero:** Fraunces + Noto Serif SC（思源宋体）— 编辑感的核心，仅用于 ≥18px 标题：项目名、方向卡标题、提案封面、章节标题
- **Body:** Instrument Sans + Noto Sans SC（思源黑体）— 界面正文与控件，14–15px 为主
- **UI/Labels:** 同 body
- **Data/Metadata:** JetBrains Mono — 约束来源、版本号、时间戳、eyebrow 标签（大写/letter-spacing 0.12em）
- **Loading:** Google Fonts（Fraunces, Instrument Sans, JetBrains Mono, Noto Serif SC, Noto Sans SC），`font-display: swap`
- **Scale:** 52 / 36 / 28 / 22 / 18（serif display）· 17 / 15 / 13（sans body）· 12 / 11（mono）
- **规则：** 衬线绝不用在 <18px；字重上限 600；display 字号带负字距（-0.01em ~ -0.02em）

## Color
- **Approach:** restrained — 一个强调色，色彩稀有所以有意义。AI 生成的空间图像是界面中唯一的丰富色彩来源
- **Primary (accent 陶土):** `#b5532a` — 土、砖、木、火，指向家装材料本身。只用于：主行动按钮、确认门印章、当前关键状态
- **Neutrals（暖调）:** canvas `#faf9f5` → surface `#f3f0e9` → hairline `#e3ded4` / `#d4cec0` → mute `#6e6a61` → ink `#1c1a16`
- **Semantic（全部降饱和）:** success `#4a7a5c`, warning `#b98a2e`, error `#b0443c`, info `#587a8a`
- **Dark mode:** 完整重定义表面（`#1c1a16` 系暖黑，非纯黑），强调色提亮至 `#d0693f`，饱和度降 10–20%。暗色是可选聚焦模式，不是默认

## Spacing
- **Base unit:** 4px
- **Density:** 工作台区 compact-comfortable（8/12/16 为主）；阅读区 spacious（24/32/48 节奏）
- **Scale:** 2xs(2) xs(4) sm(8) md(12) lg(16) xl(20) 2xl(24) 3xl(32) 4xl(48) 5xl(64)

## Layout
- **Approach:** hybrid — 工作台区 grid-disciplined（三栏：项目导航 / 画布 / 约束面板，hairline 分隔）；阅读区 creative-editorial（居中 640px 书页、衬线叙事）
- **Max content width:** 阅读视图 640px；工作台无上限（面板自适应）
- **Border radius:** xs(2) 徽章 · sm(4) 按钮/输入 · md(6) 卡片 · lg(8) 书页/模态 · full 仅头像与圆形图标
- **Elevation:** 默认无阴影，hairline 分层。仅浮层（popover/modal/toast）用 `0 1px 2px rgba(28,26,22,.04), 0 8px 24px rgba(28,26,22,.06)`

## Motion
- **Approach:** minimal-functional
- **Easing:** enter `ease-out` · exit `ease-in` · move `ease-in-out`
- **Duration:** micro 120ms · short 200ms · medium 300ms（对应 tokens.css `--dur-micro/short/long`；退场快于进场，exit 用 micro + `ease-in`）
- **签名动效：** AI 生成内容用「显影」渐入 — opacity 0→1 + translateY 4px→0，300ms ease-out。不用弹跳、不用骨架屏旋转

## 领域映射（组件用法）
- **确认门** → `confirmation-seal` 陶土印章（描边章 + ✓ + 确认人 + 日期，-2° 微倾斜）。全产品只此一处仪式感，不得滥用
- **约束来源/约束强度** → `badge-source` / `badge-hard` mono 徽章（来源·户型图 / 硬约束 / 待确认）
- **方向卡** → `direction-card`：效果图缩略 + 衬线标题 + 一行策略摘要
- **提案包/设计说明** → `reading-sheet` 阅读视图：640px 书页、衬线标题、页脚 mono 版本行 + 印章
- **约束冲突** → 不静默裁决：用 warning 色 inline 提示 + 交给设计师的显式操作按钮

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-08-04 | 废弃 Webflow 营销官网风格，重做设计系统 | 旧 DESIGN.md 是营销页语言，与高密度工作台产品不匹配 |
| 2026-08-04 | 浅色纸面为默认（非深色工具风） | 用户记忆点=安静优雅的编辑感；浅色暖纸面更衬家装暖色内容，且在深色工具类别中立即可辨认（RISK-1，已确认） |
| 2026-08-04 | 衬线标题进入产品界面 | 编辑感核心载体；限制 ≥18px 规避小字号可读性问题（RISK-2，已确认） |
| 2026-08-04 | 确认门采用陶土印章仪式 | 把家装行业「定稿」仪式感带进软件；限定单点使用（RISK-3，已确认） |
| 2026-08-04 | 强调色陶土 `#b5532a` | 指向家装材料（土/砖/木）；与 Claude `#cc785c` 区分，更深更哑 |
| 2026-08-04 | 中英双字体栈 Fraunces+Noto Serif SC / Instrument Sans+Noto Sans SC | 产品界面为中文，英文 display 字体必须配中文宋体才不破坏编辑感 |
