# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

独立家装设计师：专业、每天使用、对视觉品质敏感。在接到一个住宅设计项目后，从户型图和客户对话开始，独立完成需求理解、设计方向探索与提案交付。

## Product Purpose

面向家装前期的自由画布 AI 工作台。让设计师把图放桌上 → 点选 → AI 出图落回 → 再改，在一个无限桌面上完成从需求资料到提案成果的整个前期工作。成功 = 设计师把它当作日常主力工作台，完成真实项目的提案。

## Positioning

区别于酷家乐等强制 Brief / 空间地图 / 阶段关卡的流程化工具：Qijian 不规定必须先有户型或空间地图，自由画布本身就是工作流。AI 生成的空间图像经设计师点选与连线参考后落回桌面，迭代权始终在设计师手中。

## Operating Context

- 核心工作流：放图 → 点选 → AI 出图落回 → 再改；连线表达参考关系，局部重绘做局部修改。
- 右侧多线程对话与 Agent 协作；Agent 可经工具写回桌面（生成、替换、删除、查看）。
- 项目事件与版本历史持久化；桌面布局与 Artifact 内容分离。
- 领域词汇以 CONTEXT.md 为准（设计项目、设计师、客户、设计方向、提案包、Artifact、设计桌面等）。
- 本地开发需 Node.js 22.19+、Docker Compose（PostgreSQL）、可选 Redis（BullMQ Worker）。

## Capabilities and Constraints

- 已支持：项目 CRUD、可平移缩放持久化的桌面、对话与附件、过程时间线、物件连线、`canvas_image` / `effect_image` 两类 Artifact、不可变版本历史、局部重绘、minimap。
- 已砍（不恢复）：空间地图、确认/采用审批、导出提案包、`/export` 与 confirm 流程关卡、`proposal_package` 类型壳、`sticky_note`。
- 图像生成走外部多网关 API（model id 全局唯一，未知 model 失败、禁止静默回落）；任务走 BullMQ + 独立 Worker，同项目图像任务并发上限内排队。
- Agent 不得在无工具成功结果时声称已修改桌面。
- 协作（项目成员/多人）暂不是当前产品形态；首要用户为独立设计师。

## Brand Commitments

- 名称：砌间 / Qijian AI Design。
- 界面身份承诺记录在 DESIGN.md（纸面工作室气质）；视觉细节以该文件为准。

## Evidence on Hand

暂无真实用户、案例、演示或评价素材。未来工作不得编造 testimonial、客户名、数据或媒体引用。

## Product Principles

1. 画布即工作流：不强制阶段，空间地图和确认关卡都不是前置条件。
2. 设计师裁决：AI 产出是候选，采用、否定、修改权始终在设计师；客户反馈须经设计师确认才成为设计决策。
3. 迭代要廉价：生成、替换、局部重绘、撤销都低摩擦，鼓励多轮试探而非一次定稿。
4. 事实与布局分离：Artifact 内容与桌面摆放、版本历史各自独立持久化。
5. 失败要诚实：工具失败、模型未知、任务排队都显式呈现，禁止静默回落或虚假成功。
