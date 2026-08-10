# 桌面物件显示名（display_name）

> 修订稿 2026-08-10（v2：一列 + 小文本起名并行）。吸收两轮 doubt 否决项与产品拍板。  
> 对齐 [agent-desk-world-model-fields.md](../agent-desk-world-model-fields.md) 名称三层。  
> **状态：** 实现中（2026-08-10）。列 + PATCH + 并行文本起名 + FE 标签已落地；迁移 `0019_artifact_display_name`。

## Problem

设计师扫桌只能看到 `A01`/`A12` 对话编号；语义信息只在 Agent Survey 的临时 `label` 里，且 effect 常是「从 X 生成-N」机器血缘串。人无法快速建立「哪间房 / 哪一版」心智。

## Non-goals

- 不做默认 `replace_on_desk` 来减桌面熵（见 `TODOS.md` §10 照片堆）。
- 不做嵌套小画布 / 变体树 UI。
- 不把 untrusted caption 全文当名字。
- **不用规则从 prompt 抽词当自动名**（产品否决）；自动名走小文本模型。
- 不把工具入参扩展为「可用 display_name 代替 id」。
- 不承诺历史聊天气泡随改名回写。

---

## 1. 三层身份（钉死）

| 层 | 字段 | 权威 | 存储 | 给谁 |
|----|------|------|------|------|
| 机器 id | `artifactId` | absolute | fact | 工具参数、存储、连线 |
| 对话编号 | `alias`（A01…） | derived | ephemeral（按桌上顺序每轮编） | **仅 Agent 指物**；人界面默认不主显 |
| 用户语义名 | `display_name` | high（user） | **fact，独立于图像 payload** | 人扫桌 + Agent 对用户说话 |
| 系统派生名 | `fallback_name` | derived | ephemeral（投影时算） | 无 display_name 时的 L0 填充 |
| 对外短名 | `label` | derived | ephemeral | **`display_name ?? fallback_name`**，永不单独落库 |

原则（世界模型 §1.4 / §1.6）：

- **Intent ≠ name**：`user_prompt` / `prompt` 全文禁止当 `fallback_name`（起名由小文本模型产出短名，也不回写全文）。
- **user 不被模型起名覆盖**：`source=user` 或用户已写非空名时，条件更新拒绝模型写入。
- **alias 不是名字**：随 `desk_state.objects` 顺序变；禁止当持久身份。

---

## 2. 持久化：不进图像 version payload

### 2.1 存哪（已拍板）

**`artifacts.display_name` 一列（text null）**，与像素 version / payload 分离。  
可选：`display_name_source`（`user` | `model` | null）、`display_name_updated_at`。

- 改名改列，**不** append 图像 version。  
- **不做侧车表**（除非日后列方案证伪）。

**禁止：** 把名字写进 versioned `payload` 并靠 `appendVersion` 全量替换——complete/retry/上传会抹名（doubt blocker）。

### 2.2 写路径

| 事件 | 行为 |
|------|------|
| 用户改名 | `PATCH` 只改 `display_name`（+ source=`user`）；**不** append 图像 version |
| 生成 complete / retry / 上传填图 | **只**改 payload 图像字段；SQL/服务层 **preserve** `display_name` 列 |
| 模型起名成功 | 仅当 `display_name IS NULL`（或 source 非 user）时写入；source=`model` |
| 用户清空 | `display_name = null` → 投影回退 `fallback_name` |

### 2.3 并发

- 改名与生图 finalize：**不同字段**；finalize 禁止整包 payload 写回时碰 name 列。  
- 用户改名与模型起名竞态：**user 永远赢**——写 model 名时用 `WHERE display_name IS NULL`（或 `source IS DISTINCT FROM 'user'`）。

---

## 3. fallback_name（投影，可每轮变）

编译读模型时计算（可演进现 `buildLabels`，但**职责收窄**）：

**目标顺序（修订后）：**

1. 上传图 + 有可用文件名 → 清洗后的短文件名（去扩展名、去 `IMG_####` 类纯序号可降权）。
2. `effect_image` + ready 且尚无 `display_name` → **`效果图-N`**（桌上序号）；**不要**「从 {父} 生成-N」当人读主名。  
   （语义名应来自并行文本起名写入的 `display_name`，不靠 fallback 装聪明。）
3. pending → `生成中-N`；failed → `生成失败-N`；empty → `空图-N`。
4. 同桌投影结束时保证 **本轮 `label` 唯一**（后缀 `-2` 只加在 **ephemeral fallback**，不写回 `display_name`）。

**血缘串（`从 {源} 生成-N`）：**

- 可保留在 Survey **次要字段**或 debug（如 `lineage_hint`），**禁止**作为人界面主文案，也**禁止** backfill 进 `display_name`。

**同桌重名数字：**

- 只在 **ephemeral** `fallback_name` / 投影 `label` 上消歧。
- **禁止**把「客厅-2」持久进 `display_name`（删卡后脏编号 / 并发双写）。

---

## 4. 自动起名（小文本模型，与出图并行）

### 4.1 定案

| 项 | 决定 |
|----|------|
| 方式 | **小文本模型**起短名（复用现有 `TEXT_API_*` / chat 文本通道，**不是**图像 API） |
| 规则抽取 | **不做**（产品否决） |
| 时机 | **与出图并行（B）**：创建 pending / job 启动时即发起命名；**不**等图像 API 返回 |
| 写入条件 | 仅 `display_name` 仍为空且非用户已写 |

名字依赖 **意图文案**（`user_prompt` 等），不依赖像素——故可与出图并行。

### 4.2 时序

```
用户提交生成
  ├─ 创建/锁定 artifact（pending）
  ├─ 任务 A：图像生成 ──────────────► complete 写 file_id（不碰 display_name）
  └─ 任务 B：文本起名（输入=意图）──► 成功则 WHERE display_name IS NULL 写入
桌面：pending 阶段可先显示 fallback「生成中-N」；
      起名先完成 → 未选中卡上已是语义名，图稍后到；
      图先完成、起名未完 → 短暂 fallback，起名到齐再替换（仍仅空名可写）
```

**兜底 C：** 并行命名失败/超时，可在 complete 后 **再试一次** 文本起名；仍失败则保持 null，靠 `fallback_name`。

**取消/失败：** 生成 job 取消时，命名请求应 abort 或结果丢弃；failed 卡不强制留模型名（可保留已写出的 model 名便于辨认，实现自选，须测）。

### 4.3 模型输入 / 输出契约

**输入（给文本模型）：**

- `user_prompt`（主）  
- 可选：源物件已有 `display_name` / 短 label（「从客厅改」时保持话题连续）  
- **不要**塞整图、**不要**等 caption  

**输出约束（prompt + 服务端校验）：**

- 单行短名，约 4–12 字（中文计字或统一 max length）  
- 偏好 `空间` 或 `空间 · 区分点`  
- 禁止：UUID、A0x、整段 prompt 复读、「从 X 生成」、空串  

校验失败 → 当次起名失败，走 fallback / 兜底重试，**不**把脏串写入列。

### 4.4 与用户改名 / replace

- 用户随时可改；写入 source=`user`。  
- 之后任何模型起名 **不得覆盖 user**（条件更新）。  
- 用户清空 → null → 允许再次模型起名（可选；默认清空后仅 fallback，直到再次生成触发）。  
- **replace 成功 + 强制重起名（产品 2026-08-10 拍板）：** 原卡替换成功后，若 `source` 不是 `user`，用**新 prompt** 再调文本起名并覆盖旧 model 名；`source=user` 仍不动。旁落新卡仍只在空名时起名。

### 4.5 上传图（无生成意图时）

- 无 `user_prompt` 的上传：可不调模型；`display_name` 保持 null，fallback 用清洗文件名。  
- 若产品要统一「都有名」：可对文件名再调一次文本润色——**可选，非 MVP**。

---

## 5. 人界面

### 5.1 显示

| 状态 | 行为 |
|------|------|
| **未选中** | 卡外上方（现 `.desk-alias-badge` 锚点）显示 **`label`（优先 display_name）**；字族改为 UI sans 12px / mute，勿 mono 机器号气质 |
| **单选** | **隐藏**卡上名称（减噪；顶工具条 + 底 prompt 已占编辑态）。**理由是编辑态减噪，不是「与 chrome 抢位」**（角标在卡外，抢位论证不成立） |
| **多选** | **仍显示**各卡名称（否则无法指认） |
| **A 号** | 默认不主显；**悬停**卡片或名称时 tooltip：`对话编号 A12`（保留人→Agent 抄号通道） |

### 5.2 改名手势

| 手势 | 目标 | 行为 |
|------|------|------|
| **双击名称** | 卡外上方 `label` 文案（不是图） | 就地编辑 — **主入口** |
| 双击图/卡身 | 图像区域 | **仍是 lightbox**（现网，不改） |
| 选中后（名称已藏） | 底栏/属性「名称」 | 补充入口，避免只能先取消选中再改名 |
| 可选 | 右键/⋯ 「重命名」 | 补充 |

实现要点：

- 名称节点 `pointer-events: auto`，并在 pointer 事件上 **stopPropagation**，避免冒泡成「双击卡 → 大图」。
- 未选中时名称可见，双击名称即可改；不必先选中。
- Enter 提交 / Esc 取消；空提交 = 清空 → `display_name = null` → 回 fallback。

**doubt 澄清：** 被否决的是「双击卡/图改名」与 lightbox 抢手势；**双击名称 ≠ 双击图**，主入口成立。

### 5.3 其它表面

| 表面 | 主文案 |
|------|--------|
| 聊天选中 chip | `label`（lifecycle 必要时后缀，如 `生成中`）；**禁止** `A12 · 效果图` 当唯一主文案；A 号可次要 |
| lightbox | 标题槽 = `label` |
| Agent overview 拼图 | 仍可画 **alias**（机器通道） |
| 项目封面 human | 不画 A；若叠字用极短 label 或继续纯图 |

---

## 6. Agent

### 6.1 Survey / compile

```
A05 effect_image <id> 「{label}」 ready g…
```

- `label = display_name ?? fallback_name`（与 FE 同一公式）。
- 指代解析优先级（对齐世界模型，**显式 id/alias 优先于名**）：

  1. artifact id  
  2. alias `A0x`  
  3. `display_name` 唯一命中  
  4. `fallback_name` / `label` 唯一命中  
  5. 受控关键词（如「材质」）；**「客厅」类空间词**保持现网保护：优先 `canvas_image` ready，避免效果图 title 含「客厅」时误抢源图——**不得**改成「title 无脑优先」  

- 工具参数：**仅 id**（解析入口可接受 alias）；**不接受** display_name 作工具参数。

### 6.2 对用户说话

- Prompt 要求：优先 `label`；需消歧时再补 alias。  
- **诚实边界：** 这是软约束，无编译器保证；验收靠 dogfood / 抽检，不伪造系统强制。

---

## 7. 与照片堆（§10）的衔接

| 层级 | 命名 |
|------|------|
| 堆入口 | 用户/系统对「话题」的 display_name（如 `客厅`） |
| 堆内版本 | 各 artifact 自己的 display_name 或 fallback 区分点 |
| 散卡 | 同一 `display_name` / `fallback_name` 模型 |

堆落地前**不**要求 title 可拆 `空间 · 区分点`；避免错误格式锁死。

---

## 8. 迁移与发布

1. Migration：`artifacts.display_name`（+ 可选 source/updated_at）+ `PATCH` 改名 API。  
2. `compileDeskObjects` / FE map：`label = display_name ?? fallback_name`；fallback 去掉「血缘串作主名」。  
3. **旧卡：** 不批量把 `从 X 生成-N` 写入列；null + fallback 即可。上传图可按文件名写 model/file 名仅当产品要（非必须）。  
4. FE：未选中显示 label；单选隐藏；多选显示；双击名称改名；chip/lightbox。  
5. 生成 job：**并行**文本起名 + 出图；complete **preserve** 列。  
6. 测：user 名不被 complete 抹掉；model 写不覆盖 user；命名与出图并行时序。  
7. 文档：世界模型「display_name 落库位置」收口为 **artifact 列**。

**滚动发布：** 改名 API 与读路径必须同列；禁止 payload 与列双真相。

---

## 9. 契约（验收）

1. 未选中扫桌：不看 A 号也能靠 `label` 区分房间/题材（模型名可糙，须可改）。  
2. 用户改名后：画布、新一轮 Survey、chip、lightbox 一致；生图 complete/retry **不丢名**。  
3. 单选编辑态卡上不堆名称；多选仍能靠名称区分。  
4. 人主文案无「从 X 生成-N」。  
5. Agent 仍可用 A01 指物；工具仍只用 artifact id。  
6. 双击图 → 大图；双击名称 → 改名；二者命中不重叠。  
7. 起名与出图并行：不因等图才起名；起名失败不影响出图成功。  
8. 模型起名不得覆盖 `source=user`。

---

## 10. 原方案被否决项（对照）

| 原主张 | 修订 |
|--------|------|
| `payload.display_title` + locked | → **`artifacts.display_name` 列**，与 version payload 分离 |
| 规则抽词 / vision 枚举链 | → **小文本模型起名**；与出图**并行**，complete 兜底 |
| 等图像 ready 再起名 | → 名字不依赖像素；主路径不串在出图后 |
| `label` 直接等于持久 title | → `label = display_name ?? fallback_name` |
| 双击卡改名 | → **双击名称区**；双击图仍 lightbox；单选藏名时用面板 |
| 选中藏名因抢 chrome | → 单选减噪；多选仍显示 |
| 重名后缀持久化 | → 仅 ephemeral fallback |
| buildLabels 回填 display | → 禁止血缘串进 fact |

---

## 11. 已定 / 仍开放

**已定：**

1. 存储：**artifact 一列**（+ source / updated_at）。  
2. 自动起名：**小文本模型**，**禁止**规则抽词主路径。  
3. 时机：**与出图并行**；complete 后仅兜底。  

**仍开放：**

1. 设置项「始终显示 A 号」是否要做。  
2. 照片堆落地时堆入口名是否独立 fact。  
3. 起名用的具体 model id / prompt 文案 / timeout（实现时与 `TEXT_API_*` 对齐）。
