# 以 Artifact 作为平台与 skill 的领域契约

平台和 `design-proposal` skill 需要共享项目状态，但不应互相依赖界面、模型或工具实现。我们采用 Artifact 作为领域契约，并让已确认的 Artifact 版本不可变、通过 `current` 指针表示当前版本；这样可以支持追溯、回退和模型替换，同时保留设计师对确认内容的控制权。

**Status:** accepted

**Considered Options**

- 由平台数据库直接暴露内部表结构：拒绝，因为会把 skill 绑定到平台实现。
- 由对话历史作为状态来源：拒绝，因为不可稳定校验、回退和复用。
- 使用可覆盖的单份 JSON：拒绝，因为无法可靠区分草稿、确认和过期版本。

