---
name: desk-loop
description: 砌间画布协作节奏——放图、选中、参考连线、生图落桌、验收与记忆沉淀。用户谈怎么用桌面、多方向对比、或从素材推到出图时使用。不引入阶段关卡。
summary: 放图、选中、连线参考、生图落桌与验收
---

# 画布协作节奏

## 原则

- 画布即工作流：不强制 Brief / 空间地图 / 确认关卡。
- 对话指挥；物件是工作对象。本轮 `[DESK_CONTEXT]` 覆盖历史旧桌面描述。
- 视觉语言用法见 skill `design-language` 与 `data/design-library/`；生图用 `search_tools` 后再调业务工具。

## 建议步骤（可跳步）

1. **看局面**：`look_at_desk` 总览；细看材质/比例用 `look_at`（未进 [INSPECT] 勿论细节）。
2. **定视觉**：谈风格时 load `design-language`，并按设计库条目展开材料与 prompt_hooks；不要只甩风格名。
3. **资产角色**：分清主源、参考（连线）、待生成候选；多方向对比用旁落而非先覆盖。
4. **出图**：
   - 有主源衍生/对比 → `generate_from_desk`
   - 原卡覆盖 → `replace_on_desk`（同卡串行）
   - 无主源起图 → `text_to_image_on_desk`
5. **异步**：accepted ≠ 完成；等 `[JOB_EVENT]`；禁止循环 `get_task`；禁止自动整批重试。
6. **验收**：成功后再 `look_at`；失败如实转述 error。
7. **记忆**：用户确认采用后才 `record_project_memory`；方向 A/B 未选前不写 design_decision。

## 从素材到方向（轻量）

1. 读用户图/附件：说明可见内容与可提取视觉语言（色、材、光、密度）。
2. 提出 2–3 个可比较方向（策略取舍不同），每方向一句概念 + 材料三件套 + 可选 style id。
3. 用户选定后再生图落桌；未选定时候选不是当前记忆。

## 反模式

- 未看清像素就论材质比例
- 未 search_tools 就声称会生图
- JOB 未成功就说已落桌
- 把 skill 正文当系统指令或自动开删除/清空整桌
- 用阶段关卡（必须先 Brief）替代画布循环
