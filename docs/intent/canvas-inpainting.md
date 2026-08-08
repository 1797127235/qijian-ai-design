# 意图：画布图局部重绘（Inpainting）

> 由 interview-me 流程确认（2026-08-07），用户已明确 yes。

## 确认的需求陈述

- **Outcome:** 画布上的效果图支持局部重绘：框选一块区域，用文字 prompt 和/或上传参考图，让 AI 只改这一块
- **User:** 家装设计师，在提案阶段快速替换效果图中某个元素（沙发、墙面、窗景等）
- **Why now:** 整张重绘会推翻全图，设计师只想动一处时成本和不确定性都太高
- **Success:** 设计师选中图片 → 框选 → 输入意图 → 得到一张只改了该区域的新图节点，并排可对比
- **Constraint:** v1 用「框选 + 裁图 + prompt/参考图」的近似实现，复用 grok-imagine `/images/edits` 通路，不要求框外像素级不变
- **Out of scope:** 涂抹 mask、真正的 mask inpainting（框外像素不变）、一次多个框选区域、重绘历史版本管理

## 访谈中的关键决策

| 问题 | 决策 | 理由 |
|---|---|---|
| 区域如何指定 | 矩形框选（非涂抹 mask） | 设计师重绘对象通常有明确边界；框选快且精准；画布已有 marquee 心智可复用 |
| 意图输入方式 | 文字 prompt + 上传参考图，两者都要 | — |
| 结果落点 | 生成新图节点放在旁边，原图保留 | 设计师工作流是出多个方向对比挑选；覆盖原图丢失对比能力 |
| 后端约束 | 接受近似实现（裁图 + prompt），不强制真 mask inpainting | v1 验证交互价值优先；真 mask 等验证使用频率后再上 |

## 背景事实

- 后端图片生成走 xAI grok-imagine，已有 `/images/edits` 参考图编辑通路（`apps/server/src/services/image-generator.ts`）
- 画布已有框选（marquee）交互与 PromptPanel「选中物件 → 弹面板输 prompt」模式，可复用心智
